import type { Api, Model } from "@oh-my-pi/pi-ai";
import { pickDefaultAvailableModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";

export function preferredDefaultModel(
	available: readonly Model<Api>[],
	hasConcreteAuth?: (provider: string) => boolean,
): Model<Api> | undefined {
	return pickDefaultAvailableModel([...available], hasConcreteAuth);
}
