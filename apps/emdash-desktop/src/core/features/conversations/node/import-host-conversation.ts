import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createConversationRegistry } from '@core/features/conversations/api/node/registry';
import { projectEvents } from '@core/features/projects/api/node/project-events';
import {
  createWorkspaceRegistry,
  type WorkspaceRegistry,
} from '@core/features/workspaces/api/node/registry';
import type { Project } from '@core/primitives/projects/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { appDbPokes } from '@core/services/app-db/node/pokes';
import {
  projects,
  tasks,
  type ProjectRow,
  type WorkspaceRow,
} from '@core/services/app-db/node/schema';
import { linkConversationToTask } from './link-conversation-to-task';

export type ImportHostConversationInput = {
  conversationId: string;
  /** Override task name; defaults to conversation title or workspace basename. */
  taskName?: string;
  /** Override project name when creating; defaults to repository path basename. */
  projectName?: string;
};

export type ImportHostConversationResult = {
  projectId: string;
  taskId: string;
  createdProject: boolean;
};

/**
 * Claims a host-durable unlinked conversation onto this desktop as a local task
 * (and project when needed). Host records are untouched — only desktop project/task
 * rows and conversation annotations are written so the conversation can appear in
 * task UI and resume against the shared host session.
 */
export async function importHostConversation(
  db: AppDb,
  input: ImportHostConversationInput
): Promise<ImportHostConversationResult> {
  const conversationRegistry = createConversationRegistry(db);
  const workspaceRegistry = createWorkspaceRegistry(db);
  const conversation = conversationRegistry.getLive(input.conversationId);
  if (!conversation) {
    throw new Error(`Conversation ${input.conversationId} was not found`);
  }
  if (conversation.location === null) {
    throw new Error(`Conversation ${input.conversationId} has no host location`);
  }
  if (!conversation.workspacePath?.trim()) {
    throw new Error(`Conversation ${input.conversationId} has no workspace path to import`);
  }
  if (conversation.deletionTombstone !== null) {
    throw new Error(`Conversation ${input.conversationId} is pending removal`);
  }

  // Already claimed on this device: return the live link instead of duplicating a task.
  if (conversation.projectId && conversation.taskId) {
    const [existingTask] = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.id, conversation.taskId),
          eq(tasks.projectId, conversation.projectId),
          isNull(tasks.deletedAt)
        )
      )
      .limit(1)
      .all();
    if (existingTask) {
      return {
        projectId: conversation.projectId,
        taskId: conversation.taskId,
        createdProject: false,
      };
    }
  }

  const workspace = workspaceRegistry.findLiveByPath(
    conversation.location,
    conversation.sshConnectionId,
    conversation.workspacePath
  );
  if (!workspace) {
    throw new Error(
      `No workspace mirror found for ${conversation.workspacePath}. Wait for the host to sync, then retry.`
    );
  }
  if (workspace.deletionTombstone !== null) {
    throw new Error(`Workspace ${workspace.path ?? workspace.id} is pending removal`);
  }

  const repository = resolveRepositoryWorkspace(workspaceRegistry, workspace);
  if (!repository.path?.trim()) {
    throw new Error(`Repository workspace ${repository.id} has no path`);
  }

  const existingProject = findProjectForRepository(db, repository.id);
  let projectId = existingProject?.id ?? null;
  let createdProject = false;

  if (!projectId) {
    const created = createProjectForRepository(db, {
      repository,
      name: input.projectName?.trim() || pathBasename(repository.path),
    });
    projectId = created.id;
    createdProject = true;
  }

  const taskId = randomUUID();
  const taskName =
    input.taskName?.trim() ||
    conversation.title?.trim() ||
    pathBasename(conversation.workspacePath);

  db.insert(tasks)
    .values({
      id: taskId,
      projectId,
      name: taskName,
      status: 'in_progress',
      workspaceId: workspace.id,
      type: 'task',
      updatedAt: sql`CURRENT_TIMESTAMP`,
      statusChangedAt: sql`CURRENT_TIMESTAMP`,
      lastInteractedAt: sql`CURRENT_TIMESTAMP`,
    })
    .run();

  await linkConversationToTask(db, {
    conversationId: conversation.id,
    projectId,
    taskId,
  });

  // Orphans have no initial flag; mark so the task opens this conversation first.
  createConversationRegistry(db).annotate(conversation.id, {
    projectId,
    taskId,
    isInitialConversation: true,
  });
  appDbPokes.conversations.poke({ projectId, taskId });
  appDbPokes.tasks.poke({ projectId, taskId });
  appDbPokes.projects.poke({ projectId });
  appDbPokes.workspaces.poke({ projectId, taskId, workspaceId: workspace.id });

  return { projectId, taskId, createdProject };
}

function resolveRepositoryWorkspace(
  registry: WorkspaceRegistry,
  workspace: WorkspaceRow
): WorkspaceRow {
  if (workspace.parentId) {
    const parent = registry.getLive(workspace.parentId);
    if (!parent) {
      throw new Error(
        `Worktree ${workspace.path ?? workspace.id} has no mirrored parent repository`
      );
    }
    return parent;
  }
  return workspace;
}

function findProjectForRepository(
  db: AppDb,
  repositoryWorkspaceId: string
): { id: string; name: string } | undefined {
  return db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      and(eq(projects.repositoryWorkspaceId, repositoryWorkspaceId), isNull(projects.deletedAt))
    )
    .limit(1)
    .get();
}

function createProjectForRepository(
  db: AppDb,
  input: { repository: WorkspaceRow; name: string }
): { id: string } {
  const projectId = randomUUID();
  const row = db
    .insert(projects)
    .values({
      id: projectId,
      name: input.name,
      baseRef: null,
      repositoryWorkspaceId: input.repository.id,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .returning()
    .get();

  const project = projectFromRepositoryRow(row, input.repository);
  if (project) {
    projectEvents._emit('project:created', project);
  }
  return { id: row.id };
}

function projectFromRepositoryRow(row: ProjectRow, repository: WorkspaceRow): Project | null {
  if (!repository.path) return null;
  return repository.location === 'remote'
    ? {
        type: 'ssh',
        id: row.id,
        name: row.name,
        path: repository.path,
        baseRef: row.baseRef,
        connectionId: repository.sshConnectionId ?? '',
        repositoryWorkspaceId: row.repositoryWorkspaceId ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    : {
        type: 'local',
        id: row.id,
        name: row.name,
        path: repository.path,
        baseRef: row.baseRef,
        repositoryWorkspaceId: row.repositoryWorkspaceId ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
}

function pathBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const parts = trimmed.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}
