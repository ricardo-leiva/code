import { container } from "../di/container";
import { MAIN_TOKENS } from "../di/tokens";
import { DevFlagsEvent } from "./dev-flags/schemas";
import type { DevFlagsService } from "./dev-flags/service";
import type { DevLogsService } from "./dev-logs/service";
import type { DevNetworkService } from "./dev-network/service";

export function initDevToolbar(): void {
  const flags = container.get<DevFlagsService>(MAIN_TOKENS.DevFlagsService);
  const network = container.get<DevNetworkService>(
    MAIN_TOKENS.DevNetworkService,
  );
  const logs = container.get<DevLogsService>(MAIN_TOKENS.DevLogsService);

  const installCapture = () => {
    network.install();
    logs.install();
  };

  if (flags.getFlags().devMode) installCapture();

  flags.on(DevFlagsEvent.Changed, (next) => {
    if (next.devMode) installCapture();
  });
}
