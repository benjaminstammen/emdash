import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConversationRegistry } from '@core/features/conversations/api/node/registry';
import { createWorkspaceRegistry } from '@core/features/workspaces/api/node/registry';
import { projects, tasks } from '@core/services/app-db/node/schema';
import { importHostConversation } from './import-host-conversation';

describe('importHostConversation', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
  });

  afterEach(() => {
    fixture.close();
  });

  function seedRemoteConnection(id: string): void {
    fixture.sqlite
      .prepare(
        `INSERT INTO ssh_connections (id, name, host, username) VALUES (?, ?, 'remote.example', 'user')`
      )
      .run(id, `Machine ${id}`);
  }

  function seedRepositoryAndWorktree(opts: {
    connectionId: string;
    repoId: string;
    repoPath: string;
    worktreeId: string;
    worktreePath: string;
  }): void {
    const registry = createWorkspaceRegistry(fixture.db);
    registry.adopt({
      id: opts.repoId,
      kind: 'repository',
      location: 'remote',
      sshConnectionId: opts.connectionId,
      parentId: null,
      type: 'project-ssh',
      origin: 'adopted',
      path: opts.repoPath,
      observedStatus: 'present',
    });
    registry.adopt({
      id: opts.worktreeId,
      kind: 'worktree',
      location: 'remote',
      sshConnectionId: opts.connectionId,
      parentId: opts.repoId,
      type: 'project-ssh',
      origin: 'adopted',
      path: opts.worktreePath,
      observedStatus: 'present',
    });
  }

  function seedOrphanConversation(opts: {
    id: string;
    connectionId: string;
    workspacePath: string;
    title?: string;
  }): void {
    createConversationRegistry(fixture.db).adopt({
      id: opts.id,
      title: opts.title ?? `Conversation ${opts.id}`,
      provider: 'claude',
      type: 'acp',
      location: 'remote',
      sshConnectionId: opts.connectionId,
      workspacePath: opts.workspacePath,
      cwd: opts.workspacePath,
      observedStatus: 'present',
    });
  }

  it('creates a project and task, then annotates the orphan conversation', async () => {
    seedRemoteConnection('ssh-1');
    seedRepositoryAndWorktree({
      connectionId: 'ssh-1',
      repoId: 'repo-1',
      repoPath: '/home/user/code/emdash',
      worktreeId: 'wt-1',
      worktreePath: '/home/user/worktrees/emdash-global-projects',
    });
    seedOrphanConversation({
      id: 'conv-1',
      connectionId: 'ssh-1',
      workspacePath: '/home/user/worktrees/emdash-global-projects',
      title: 'Finish import flow',
    });

    const result = await importHostConversation(fixture.db, { conversationId: 'conv-1' });

    expect(result.createdProject).toBe(true);
    const project = fixture.db
      .select()
      .from(projects)
      .where(eq(projects.id, result.projectId))
      .get();
    expect(project).toMatchObject({
      id: result.projectId,
      name: 'emdash',
      repositoryWorkspaceId: 'repo-1',
    });
    const task = fixture.db.select().from(tasks).where(eq(tasks.id, result.taskId)).get();
    expect(task).toMatchObject({
      id: result.taskId,
      projectId: result.projectId,
      name: 'Finish import flow',
      workspaceId: 'wt-1',
      status: 'in_progress',
    });
    expect(createConversationRegistry(fixture.db).getLive('conv-1')).toMatchObject({
      projectId: result.projectId,
      taskId: result.taskId,
      isInitialConversation: true,
    });
  });

  it('reuses an existing project for the repository workspace', async () => {
    seedRemoteConnection('ssh-1');
    seedRepositoryAndWorktree({
      connectionId: 'ssh-1',
      repoId: 'repo-1',
      repoPath: '/home/user/code/emdash',
      worktreeId: 'wt-1',
      worktreePath: '/home/user/worktrees/emdash-global-projects',
    });
    fixture.sqlite
      .prepare(`INSERT INTO projects (id, name, repository_workspace_id) VALUES (?, ?, ?)`)
      .run('project-existing', 'Existing EmDash', 'repo-1');
    seedOrphanConversation({
      id: 'conv-2',
      connectionId: 'ssh-1',
      workspacePath: '/home/user/worktrees/emdash-global-projects',
      title: 'Continue at work',
    });

    const result = await importHostConversation(fixture.db, { conversationId: 'conv-2' });

    expect(result.createdProject).toBe(false);
    expect(result.projectId).toBe('project-existing');
    const task = fixture.db.select().from(tasks).where(eq(tasks.id, result.taskId)).get();
    expect(task).toMatchObject({
      projectId: 'project-existing',
      name: 'Continue at work',
      workspaceId: 'wt-1',
    });
  });

  it('returns the existing link when the conversation is already claimed', async () => {
    seedRemoteConnection('ssh-1');
    seedRepositoryAndWorktree({
      connectionId: 'ssh-1',
      repoId: 'repo-1',
      repoPath: '/home/user/code/emdash',
      worktreeId: 'wt-1',
      worktreePath: '/home/user/worktrees/emdash-global-projects',
    });
    fixture.sqlite
      .prepare(`INSERT INTO projects (id, name, repository_workspace_id) VALUES (?, ?, ?)`)
      .run('project-1', 'EmDash', 'repo-1');
    fixture.sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, name, status, workspace_id) VALUES (?, ?, ?, 'in_progress', ?)`
      )
      .run('task-1', 'project-1', 'Already linked', 'wt-1');
    createConversationRegistry(fixture.db).register({
      id: 'conv-linked',
      projectId: 'project-1',
      taskId: 'task-1',
      title: 'Already linked',
      provider: 'claude',
      type: 'acp',
      location: 'remote',
      sshConnectionId: 'ssh-1',
      workspacePath: '/home/user/worktrees/emdash-global-projects',
      cwd: '/home/user/worktrees/emdash-global-projects',
      isInitialConversation: true,
    });

    await expect(
      importHostConversation(fixture.db, { conversationId: 'conv-linked' })
    ).resolves.toEqual({
      projectId: 'project-1',
      taskId: 'task-1',
      createdProject: false,
    });
  });

  it('rejects conversations without a mirrored workspace path', async () => {
    seedRemoteConnection('ssh-1');
    seedOrphanConversation({
      id: 'conv-missing-ws',
      connectionId: 'ssh-1',
      workspacePath: '/missing/worktree',
    });

    await expect(
      importHostConversation(fixture.db, { conversationId: 'conv-missing-ws' })
    ).rejects.toThrow('No workspace mirror found');
  });
});
