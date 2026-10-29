#!/usr/bin/env -S ERL_FLAGS=+B elixir
Mix.install([])

if System.get_env("DEPS_ONLY") == "true" do
  System.halt(0)
  Process.sleep(:infinity)
end

defmodule ForkSync do
  @moduledoc """
  Keeps this fork's `main` as the newest upstream stable release tag plus
  custom patches, and builds and installs the patched Emdash app.

  The daily sync rebases `main` onto the newest `vX.Y.Z` tag of
  generalaction/emdash in a throwaway worktree, verifies it (full typecheck
  plus `vitest related` on the patched files), force-pushes it to `origin`,
  and builds the app into ~/emdash/fork-builds. Conflicts and verification
  failures go to `claude -p`; anything it cannot settle leaves the worktree in
  place and posts a notification. It never installs the app by itself.

  `--install-app` swaps /Applications/Emdash.app for the newest build. It
  refuses to downgrade (the data dir may carry newer migrations), quits Emdash
  the normal way (sessions persist and resume exactly as on an official
  update), and keeps the previous app plus an APFS clone of the data dir.
  `--rollback` puts the previous app back; the data dir is restored only by hand.

  ## Usage

      $ tooling/fork/sync-upstream.exs               # sync + build now
      $ tooling/fork/sync-upstream.exs --dry-run     # sync without push or build
      $ tooling/fork/sync-upstream.exs --build-app   # build origin/main if missing
      $ tooling/fork/sync-upstream.exs --install-app # swap in the newest build
      $ tooling/fork/sync-upstream.exs --rollback    # restore the previous app
      $ tooling/fork/sync-upstream.exs --install     # daily launchd job (07:00)
      $ tooling/fork/sync-upstream.exs --uninstall

  `EMDASH_FORK_REPO` overrides the repo path (default ~/Source/bricabrac/emdash).
  """

  @args [
    help: :boolean,
    install: :boolean,
    uninstall: :boolean,
    dry_run: :boolean,
    build_app: :boolean,
    install_app: :boolean,
    rollback: :boolean
  ]
  @upstream_url "https://github.com/generalaction/emdash.git"
  @label "org.bricabrac.emdash-fork-sync"
  @claude_tools "Bash(git *) Bash(pnpm *) Read Edit Write Glob Grep"
  @bundle_id "com.emdash.stable"
  @installed_app "/Applications/Emdash.app"
  @official_team "2AZ6648627"
  @kept_builds 3
  @kept_backups 3

  def main(args) do
    {parsed, args} = OptionParser.parse!(args, strict: @args)
    cmd(parsed, args)
  end

  defp cmd([help: true], _), do: IO.puts(@moduledoc)
  defp cmd([install: true], []), do: install()
  defp cmd([uninstall: true], []), do: uninstall()
  defp cmd([], []), do: guarded(fn -> sync(dry_run: false) end)
  defp cmd([dry_run: true], []), do: guarded(fn -> sync(dry_run: true) end)
  defp cmd([build_app: true], []), do: guarded(fn -> ensure_build(fetch!(repo())) end)
  defp cmd([install_app: true], []), do: guarded(&install_app/0)
  defp cmd([rollback: true], []), do: guarded(&rollback/0)

  defp cmd(_parsed, _args) do
    IO.puts(@moduledoc)
    System.stop(1)
  end

  defp guarded(fun) do
    fun.()
  rescue
    error ->
      log("CRASHED: #{Exception.format(:error, error, __STACKTRACE__)}")
      notify("Crashed. See ~/Library/Logs/emdash-fork-sync.log")
      System.stop(1)
  end

  # -- sync --------------------------------------------------------------------

  defp sync(opts) do
    repo = repo()
    log("sync start (#{repo})")
    %{tag: tag, sha: old} = fetch!(repo)

    if ancestor?(repo, tag, old) do
      log("origin/main already sits on #{tag}")
      unless opts[:dry_run], do: ensure_build(%{repo: repo, sha: old})
    else
      rebase_and_push(repo, tag, old, opts)
    end
  end

  # Fetches origin/main and upstream release tags; returns the newest stable tag.
  defp fetch!(repo) do
    ensure_upstream_remote(repo)
    git!(repo, ~w(fetch --prune origin main))
    git!(repo, ["fetch", "--prune", "--force", "upstream", "+refs/tags/v*:refs/tags/v*"])

    tag =
      git!(repo, ["tag", "--list", "v*", "--sort=-v:refname"])
      |> String.split("\n", trim: true)
      |> Enum.find(&String.match?(&1, ~r/^v\d+\.\d+\.\d+$/)) || raise "no stable tag found"

    %{repo: repo, tag: tag, sha: rev!(repo, "origin/main")}
  end

  defp rebase_and_push(repo, tag, old, opts) do
    worktree = add_worktree(repo, "sync", old)

    with :ok <- rebase(worktree, tag),
         :ok <- verify_or_fix(worktree, tag) do
      new = rev!(worktree, "HEAD")
      patches = git!(worktree, ["log", "--oneline", "#{tag}..HEAD"])
      log("patches on #{tag}:\n#{patches}")

      if opts[:dry_run] do
        log("dry run: would push #{new} to origin/main; worktree kept at #{worktree}")
      else
        git!(worktree, ["push", "--force-with-lease=main:#{old}", "origin", "HEAD:main"])
        update_local_main(repo, old, new)
        git!(repo, ["worktree", "remove", "--force", worktree])
        notify("Rebased #{count_lines(patches)} patch(es) onto #{tag} and pushed.")
        ensure_build(%{repo: repo, sha: new})
      end
    else
      {:error, reason} ->
        log("FAILED: #{reason}\nworktree kept at #{worktree}")
        notify("Sync failed: #{reason}. See ~/Library/Logs/emdash-fork-sync.log")
        System.stop(1)
    end
  end

  defp rebase(worktree, base) do
    case git(worktree, ["rebase", base]) do
      {_, 0} ->
        :ok

      {out, _} ->
        log("rebase stopped:\n#{out}")
        claude(worktree, conflict_prompt(base))
        if rebasing?(worktree), do: {:error, "rebase conflicts unresolved"}, else: :ok
    end
  end

  defp verify_or_fix(worktree, base) do
    case verify(worktree, base) do
      :ok ->
        :ok

      {:error, out} ->
        claude(worktree, fix_prompt(base, out))

        cond do
          rebasing?(worktree) -> {:error, "fix left a rebase in progress"}
          verify(worktree, base) == :ok -> :ok
          true -> {:error, "verification still failing after claude fix"}
        end
    end
  end

  defp verify(worktree, base) do
    steps =
      [
        {"pnpm", ["install", "--frozen-lockfile"], worktree},
        {"pnpm", ["run", "typecheck"], worktree}
      ] ++ related_test_steps(worktree, base)

    run_steps(steps, worktree)
  end

  # Groups the patches' changed TS sources by workspace project and runs only
  # the Vitest tests related to them.
  defp related_test_steps(worktree, base) do
    git!(worktree, ["diff", "--name-only", "--diff-filter=AMR", "#{base}...HEAD"])
    |> String.split("\n", trim: true)
    |> Enum.filter(&String.match?(&1, ~r/\.tsx?$/))
    |> Enum.group_by(&project_root/1)
    |> Enum.reject(fn {root, _} -> is_nil(root) end)
    |> Enum.filter(fn {root, _} -> File.exists?(Path.join([worktree, root, "package.json"])) end)
    |> Enum.map(fn {root, files} ->
      dir = Path.join(worktree, root)
      rel = Enum.map(files, &Path.relative_to(&1, root))
      # The desktop's browser/db projects need Playwright and native deps.
      project = if root == "apps/emdash-desktop", do: ["--project", "node"], else: []
      {"pnpm", ["exec", "vitest", "related", "--run", "--passWithNoTests"] ++ project ++ rel, dir}
    end)
  end

  defp project_root(path) do
    case Path.split(path) do
      [top, name | _] when top in ["apps", "packages"] -> Path.join(top, name)
      _ -> nil
    end
  end

  defp update_local_main(repo, old, new) do
    branch = git!(repo, ~w(branch --show-current)) |> String.trim()
    clean? = git!(repo, ~w(status --porcelain)) |> String.trim() == ""

    cond do
      branch != "main" ->
        # Fails harmlessly when main is checked out in another worktree.
        git(repo, ["branch", "-f", "main", new])

      clean? and rev!(repo, "HEAD") == old ->
        git!(repo, ["reset", "--keep", new])

      true ->
        log("local main checkout is dirty or diverged; left it alone (origin/main is #{new})")
    end
  end

  # -- build -------------------------------------------------------------------

  # Builds the fork app for `sha` unless a build already exists; returns its path.
  defp ensure_build(%{repo: repo, sha: sha}) do
    case find_build(sha) do
      nil ->
        build(repo, sha)

      app ->
        log("build for #{short(sha)} already at #{app}")
        app
    end
  end

  defp build(repo, sha) do
    worktree = add_worktree(repo, "build", sha)
    desktop = Path.join(worktree, "apps/emdash-desktop")
    version = desktop |> Path.join("package.json") |> File.read!() |> JSON.decode!()

    steps = [
      {"pnpm", ["install", "--frozen-lockfile"], worktree},
      {"pnpm", ["run", "build"], worktree},
      {"node",
       ~w(--experimental-strip-types scripts/release/build.ts --platform mac --arch arm64 --targets zip --local),
       desktop}
    ]

    case run_steps(steps, worktree, [{"VITE_EMDASH_FORK", "1"}]) do
      :ok ->
        dest = Path.join(builds_dir(), "#{version["version"]}-#{short(sha)}")
        File.rm_rf!(dest)
        File.mkdir_p!(dest)
        [zip] = Path.wildcard(Path.join(desktop, "release/*.zip"))
        cmd!("ditto", ["-x", "-k", zip, dest])
        app = Path.join(dest, "Emdash.app")
        cmd!("codesign", ["--verify", "--deep", "--strict", app])
        git!(repo, ["worktree", "remove", "--force", worktree])
        prune(builds_dir(), @kept_builds)
        notify("Patched Emdash #{version["version"]} built. Install with --install-app.")
        app

      {:error, out} ->
        log("BUILD FAILED (worktree kept at #{worktree}):\n#{out}")
        notify("Patched build failed. See ~/Library/Logs/emdash-fork-sync.log")
        System.stop(1)
    end
  end

  defp find_build(sha) do
    builds_dir()
    |> Path.join("*-#{short(sha)}/Emdash.app")
    |> Path.wildcard()
    |> List.first()
  end

  # -- install / rollback ------------------------------------------------------

  defp install_app do
    app = ensure_build(fetch!(repo()))
    new = app_version(app)
    current = if File.dir?(@installed_app), do: app_version(@installed_app)

    if current && Version.compare(new, current) == :lt do
      raise "refusing to downgrade #{current} -> #{new}: the data dir may hold newer migrations"
    end

    swap_in(app, "#{installed_kind()}-#{current || "none"}")
    notify("Installed patched Emdash #{new}; previous app kept in #{backups_dir()}.")
  end

  defp rollback do
    previous =
      backups_dir()
      |> Path.join("*/Emdash.app")
      |> Path.wildcard()
      |> Enum.sort(:desc)
      |> List.first() || raise "no backup to roll back to"

    # The swap backs up the current app too, so a second rollback undoes this one.
    swap_in(previous, "#{installed_kind()}-rolled-back")
    notify("Restored #{app_version(@installed_app)} from backup. Data dir was left as is.")
  end

  # Quits Emdash normally, backs up the installed app and the data dir, then
  # installs `app` and relaunches.
  defp swap_in(app, label) do
    quit_emdash!()
    backup = Path.join(backups_dir(), "#{stamp()}-#{label}")
    File.mkdir_p!(backup)
    # APFS clone: instant and space-free until either side changes.
    cmd!("cp", ["-c", "-R", data_dir(), Path.join(backup, "appdata")])

    if File.dir?(@installed_app),
      do: File.rename!(@installed_app, Path.join(backup, "Emdash.app"))

    cmd!("ditto", [app, @installed_app])
    prune(backups_dir(), @kept_backups)
    log("installed #{app} (backup at #{backup})")
    cmd!("open", ["-b", @bundle_id])
  end

  defp quit_emdash! do
    if emdash_running?() do
      log("asking Emdash to quit")
      System.cmd("osascript", ["-e", ~s(tell application id "#{@bundle_id}" to quit)])

      quit? =
        Enum.any?(1..120, fn _ ->
          Process.sleep(1_000)
          not emdash_running?()
        end)

      unless quit? do
        raise "Emdash did not quit within 2 minutes (is a confirmation dialog open?)"
      end
    end
  end

  defp emdash_running? do
    # Workers and agents are children of the app; wait for all of them.
    match?({_, 0}, System.cmd("pgrep", ["-f", "#{@installed_app}/"]))
  end

  defp installed_kind do
    {out, _} = System.cmd("codesign", ["-dv", @installed_app], stderr_to_stdout: true)
    if String.contains?(out, "TeamIdentifier=#{@official_team}"), do: "official", else: "fork"
  end

  defp app_version(app) do
    cmd!("defaults", ["read", Path.join(app, "Contents/Info"), "CFBundleShortVersionString"])
    |> String.trim()
  end

  defp prune(dir, keep) do
    dir
    |> File.ls!()
    |> Enum.map(&Path.join(dir, &1))
    |> Enum.filter(&File.dir?/1)
    |> Enum.sort_by(&File.stat!(&1).mtime, :desc)
    |> Enum.drop(keep)
    |> Enum.each(&File.rm_rf!/1)
  end

  # -- claude ------------------------------------------------------------------

  defp claude(worktree, prompt) do
    log("handing off to claude")

    {out, status} =
      System.cmd(
        "sh",
        ["-c", ~s(exec claude "$@" </dev/null), "claude"] ++
          ["-p", prompt, "--permission-mode", "acceptEdits", "--allowedTools", @claude_tools],
        cd: worktree,
        stderr_to_stdout: true,
        env: [{"GIT_EDITOR", "true"}]
      )

    log("claude exited #{status}:\n#{tail(out, 80)}")
  end

  defp conflict_prompt(base) do
    """
    You are in a detached git worktree of a personal emdash fork. Its custom
    patches are being rebased onto the upstream release tag `#{base}`
    (generalaction/emdash) and the rebase stopped on conflicts.

    Resolve every conflict so upstream's changes are kept and each patch's
    intent survives; `git show REBASE_HEAD` shows the patch being applied. Then
    `git add` the files and run `GIT_EDITOR=true git rebase --continue`, and
    repeat until the rebase finishes. If upstream already does what a patch
    does, `git rebase --skip` it and say so. Never abort the rebase or push.
    """
  end

  defp fix_prompt(base, output) do
    """
    You are in a detached git worktree of a personal emdash fork whose custom
    patches were just rebased onto the upstream release tag `#{base}`.
    Verification failed:

    ```
    #{output}
    ```

    Fix the cause in the patches, not by weakening tests. Fold each fix into
    the patch commit it belongs to: `git commit --no-verify --fixup=<sha>`, then
    `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash #{base}`. If the
    failure is environmental or unrelated to the patches, change nothing and
    explain why. Never push.
    """
  end

  # -- launchd -----------------------------------------------------------------

  defp install do
    plist = plist_path()
    script = Path.expand(__ENV__.file)
    # Absolute tool paths: `mise exec` inside the repo would try to install its pins.
    elixir = System.find_executable("elixir") || raise "elixir not on PATH"
    erl = System.find_executable("erl") || raise "erl not on PATH"
    # Homebrew's pnpm is a node script; it then provisions the repo's pinned node.
    node = System.find_executable("node") || raise "node not on PATH"
    # node-gyp fallback for native rebuilds during packaging.
    python = System.find_executable("python3")

    bins =
      Enum.map(Enum.reject([elixir, erl, node, python], &is_nil/1), &Path.dirname/1) ++
        [Path.expand("~/.local/bin"), "/opt/homebrew/bin"]

    path = Enum.join(bins ++ ["/usr/bin", "/bin", "/usr/sbin", "/sbin"], ":")

    File.write!(plist, """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
      <key>Label</key><string>#{@label}</string>
      <key>ProgramArguments</key>
      <array>
        <string>#{elixir}</string><string>#{script}</string>
      </array>
      <key>WorkingDirectory</key><string>#{System.user_home!()}</string>
      <key>EnvironmentVariables</key>
      <dict>
        <key>PATH</key><string>#{path}</string>
        <key>EMDASH_FORK_REPO</key><string>#{repo()}</string>
      </dict>
      <key>StartCalendarInterval</key>
      <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
      <key>StandardOutPath</key><string>#{log_path()}</string>
      <key>StandardErrorPath</key><string>#{log_path()}</string>
    </dict>
    </plist>
    """)

    domain = "gui/#{uid()}"
    System.cmd("launchctl", ["bootout", "#{domain}/#{@label}"], stderr_to_stdout: true)
    {out, 0} = System.cmd("launchctl", ["bootstrap", domain, plist], stderr_to_stdout: true)
    IO.puts("installed #{plist} (daily 07:00, log #{log_path()}) #{out}")
  end

  defp uninstall do
    System.cmd("launchctl", ["bootout", "gui/#{uid()}/#{@label}"], stderr_to_stdout: true)
    File.rm(plist_path())
    IO.puts("removed #{@label}")
  end

  defp plist_path, do: Path.expand("~/Library/LaunchAgents/#{@label}.plist")
  defp log_path, do: Path.expand("~/Library/Logs/emdash-fork-sync.log")
  defp uid, do: System.cmd("id", ["-u"]) |> elem(0) |> String.trim()

  # -- helpers -----------------------------------------------------------------

  defp repo do
    System.get_env("EMDASH_FORK_REPO", Path.expand("~/Source/bricabrac/emdash"))
  end

  defp builds_dir, do: Path.expand("~/emdash/fork-builds")
  defp backups_dir, do: Path.expand("~/emdash/fork-builds-backups")
  defp data_dir, do: Path.expand("~/Library/Application Support/emdash")

  defp add_worktree(repo, kind, sha) do
    worktree = Path.expand("~/emdash/fork-sync/#{stamp()}-#{kind}")
    git!(repo, ["worktree", "add", "--detach", worktree, sha])
    worktree
  end

  defp ensure_upstream_remote(repo) do
    case git(repo, ~w(remote get-url upstream)) do
      {_, 0} -> :ok
      _ -> git!(repo, ["remote", "add", "upstream", @upstream_url])
    end
  end

  defp run_steps(steps, root, env \\ []) do
    Enum.reduce_while(steps, :ok, fn {bin, args, dir}, :ok ->
      log("run: #{bin} #{Enum.join(args, " ")} (in #{Path.relative_to(dir, root)})")

      case System.cmd(bin, args, cd: dir, stderr_to_stdout: true, env: env) do
        {_, 0} -> {:cont, :ok}
        {out, _} -> {:halt, {:error, tail(out, 200)}}
      end
    end)
  end

  defp rebasing?(dir) do
    Enum.any?(["rebase-merge", "rebase-apply"], fn name ->
      path = git!(dir, ["rev-parse", "--git-path", name]) |> String.trim()
      File.dir?(Path.expand(path, dir))
    end)
  end

  defp ancestor?(dir, a, b), do: match?({_, 0}, git(dir, ["merge-base", "--is-ancestor", a, b]))
  defp rev!(dir, ref), do: git!(dir, ["rev-parse", "#{ref}^{commit}"]) |> String.trim()
  defp short(sha), do: String.slice(sha, 0, 9)
  defp stamp, do: Calendar.strftime(DateTime.utc_now(), "%Y%m%d-%H%M%S")

  defp git(dir, args), do: System.cmd("git", ["-C", dir | args], stderr_to_stdout: true)

  defp git!(dir, args) do
    case git(dir, args) do
      {out, 0} -> out
      {out, code} -> raise "git #{Enum.join(args, " ")} exited #{code}:\n#{out}"
    end
  end

  defp cmd!(bin, args) do
    case System.cmd(bin, args, stderr_to_stdout: true) do
      {out, 0} -> out
      {out, code} -> raise "#{bin} #{Enum.join(args, " ")} exited #{code}:\n#{out}"
    end
  end

  defp tail(text, n), do: text |> String.split("\n") |> Enum.take(-n) |> Enum.join("\n")
  defp count_lines(text), do: text |> String.split("\n", trim: true) |> length()

  defp log(message) do
    IO.puts("[#{DateTime.utc_now() |> DateTime.truncate(:second)}] #{message}")
  end

  defp notify(message) do
    script = "display notification #{inspect(message)} with title \"emdash fork\""
    System.cmd("osascript", ["-e", script], stderr_to_stdout: true)
    log(message)
  end
end

ForkSync.main(System.argv())
