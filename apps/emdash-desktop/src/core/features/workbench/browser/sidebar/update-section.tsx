import { Button, MicroLabel } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { getUpdateStore } from '@core/features/updates/contributions/app-stores';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';

// Tells a locally built fork apart from the official build it shares an app id with.
const forkSuffix = import.meta.env.VITE_EMDASH_FORK === '1' ? '+fork' : '';

export const UpdateSection = observer(function UpdateSection() {
  const update = getUpdateStore();
  const { navigate } = useNavigate();

  if (update.hasUpdate) {
    return (
      <Button
        variant="secondary"
        size="xs"
        onClick={() => {
          navigate(settingsViewDef({ tab: 'general' }));
          if (update.state.status === 'available') {
            void update.download();
          }
        }}
      >
        Update
      </Button>
    );
  }

  return (
    <MicroLabel className="inline-flex h-6 items-center text-foreground-passive lowercase">
      v{update.currentVersion}
      {forkSuffix}
    </MicroLabel>
  );
});
