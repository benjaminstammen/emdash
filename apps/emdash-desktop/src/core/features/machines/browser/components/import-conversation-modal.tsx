import { Button, Dialog, Field, Input, ModalLayout } from '@emdash/ui/react/primitives';
import { useState } from 'react';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';

export interface ImportConversationModalProps {
  conversationTitle: string;
  workspacePath: string | null;
  suggestedTaskName: string;
}

export interface ImportConversationModalResult {
  taskName: string;
}

/**
 * Confirms claiming a host-durable unlinked conversation onto this desktop as a
 * local task. Project creation/reuse happens in the import op from the workspace path.
 */
export function ImportConversationModal({
  conversationTitle,
  workspacePath,
  suggestedTaskName,
}: ImportConversationModalProps) {
  const modal = useModalController('importConversationModal');
  const [taskName, setTaskName] = useState(suggestedTaskName);

  return (
    <ModalLayout
      header={
        <Dialog.Header showCloseButton>
          <Dialog.Title>Import conversation</Dialog.Title>
        </Dialog.Header>
      }
      footer={
        <Dialog.Footer>
          <Button type="button" variant="secondary" onClick={modal.dismiss}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="button"
            disabled={!taskName.trim()}
            onClick={() => {
              const trimmed = taskName.trim();
              if (!trimmed) return;
              modal.complete({ taskName: trimmed });
            }}
          >
            Import
          </Button>
        </Dialog.Footer>
      }
    >
      <Dialog.Body className="flex flex-col gap-4">
        <p className="text-sm text-foreground-muted">
          Bring <span className="text-foreground">“{conversationTitle.trim() || 'Untitled'}”</span>{' '}
          onto this device as a task. The conversation stays on the remote host; this only creates
          the local project/task link so you can open and resume it here.
        </p>
        {workspacePath && (
          <p className="rounded-md border border-border bg-background-2 px-2.5 py-2 font-mono text-xs break-all text-foreground-muted">
            {workspacePath}
          </p>
        )}
        <Field.Root>
          <Field.Label>Task name</Field.Label>
          <Input
            value={taskName}
            onChange={(event) => setTaskName(event.target.value)}
            placeholder="Task name"
            autoFocus
          />
        </Field.Root>
      </Dialog.Body>
    </ModalLayout>
  );
}

export const importConversationModal = defineModal<ImportConversationModalResult>()({
  id: 'importConversationModal',
  component: ImportConversationModal,
});
