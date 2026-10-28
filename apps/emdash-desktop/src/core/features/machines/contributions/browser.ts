import { addMachineModal } from '../browser/add-machine-modal';
import { importConversationModal } from '../browser/components/import-conversation-modal';
import { linkConversationModal } from '../browser/components/link-conversation-modal';

export const machinesBrowserContributions = {
  modalDefs: [addMachineModal, linkConversationModal, importConversationModal],
} as const;
