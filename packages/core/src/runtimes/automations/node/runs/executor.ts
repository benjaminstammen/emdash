import { randomUUID } from 'node:crypto';
import { noopLogger, type Logger } from '@emdash/shared/logger';
import type { AutomationRun } from '../../api/run';
import type { AutomationPortError } from '../ports/port-error';
import type { AutomationSessionPort } from '../ports/session-start';
import type { AutomationWorkspacePort } from '../ports/workspace-provisioning';
import type { AutomationRunTransitions } from './transitions';

export type AutomationRunExecutorOptions = {
  transitions: AutomationRunTransitions;
  workspacePort: AutomationWorkspacePort;
  sessionPort: AutomationSessionPort;
  createConversationId?: () => string;
  /** Earlier runs of the same automation whose sessions a new run supersedes. */
  previousRuns?: (run: AutomationRun) => AutomationRun[];
  logger?: Logger;
};

export type AutomationRunExecutor = (run: AutomationRun, signal: AbortSignal) => Promise<void>;

export function createAutomationRunExecutor(
  options: AutomationRunExecutorOptions
): AutomationRunExecutor {
  const {
    transitions,
    workspacePort,
    sessionPort,
    createConversationId = randomUUID,
    previousRuns = () => [],
    logger = noopLogger,
  } = options;
  const retiredRunIds = new Set<string>();

  // A run is `done` once its agent starts, and nothing else ever stops that agent, so
  // frequent schedules pile up live processes. Each new run stops its predecessors'.
  const retirePreviousSessions = async (run: AutomationRun): Promise<void> => {
    for (const previous of previousRuns(run)) {
      if (previous.id === run.id || !previous.conversationId) continue;
      if (retiredRunIds.has(previous.id)) continue;
      retiredRunIds.add(previous.id);
      const stopped = await sessionPort.stop({
        conversationId: previous.conversationId,
        agentType: previous.configSnapshot.agent.type,
      });
      if (!stopped.success) {
        logger.warn('Failed to stop a superseded automation session', {
          automationId: run.automationId,
          runId: previous.id,
          error: stopped.error,
        });
      }
    }
  };

  return async (run: AutomationRun, signal: AbortSignal): Promise<void> => {
    const provisionResult = await workspacePort.provision({
      workspace: run.configSnapshot.workspace,
      generatedName: run.generatedName,
      runId: run.id,
      signal,
    });

    if (!provisionResult.success) {
      transitions.markFailed(
        run.id,
        toRunError('provision_workspace', provisionResult.error),
        Date.now()
      );
      return;
    }

    const { workspace, branchName } = provisionResult.data;
    if (!transitions.markStartingSession(run.id, { workspace, branchName })) return;

    await retirePreviousSessions(run);

    const conversationId = createConversationId();
    const startResult = await sessionPort.start({
      conversationId,
      cwd: workspace,
      agent: run.configSnapshot.agent,
      fallbackTitle: run.configSnapshot.name,
      signal,
    });

    if (!startResult.success) {
      transitions.markFailed(run.id, toRunError('start_session', startResult.error), Date.now());
      return;
    }

    transitions.markDone(
      run.id,
      { conversationId, sessionId: startResult.data.sessionId },
      Date.now()
    );
  };
}

function toRunError(step: 'provision_workspace' | 'start_session', portError: AutomationPortError) {
  return { step, code: portError.code, message: portError.message };
}
