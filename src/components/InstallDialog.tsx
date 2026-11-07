import { useState } from 'react';
import Dialog from './Dialog';
import VersionBrowser from './VersionBrowser';

interface InstallDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * “安装新版本”弹窗：复用 VersionBrowser，安装中禁止关闭。
 */
export default function InstallDialog({ open, onClose }: InstallDialogProps): JSX.Element {
  const [installing, setInstalling] = useState(false);

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!installing) {
          onClose();
        }
      }}
      title="安装新版本"
      width="min(560px, 86vw)"
      height="min(440px, 86vh)"
      dismissible={!installing}
    >
      <VersionBrowser variant="compact" onInstallingChange={setInstalling} onDone={onClose} />
    </Dialog>
  );
}
