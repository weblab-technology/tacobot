import { boltApp } from "./bolt";
import { registerMessageHandler } from "./handlers/message";
import { registerReactionHandler } from "./handlers/reaction";
import { registerCommandHandlers } from "./handlers/commands";

registerMessageHandler(boltApp);
registerReactionHandler(boltApp);
registerCommandHandlers(boltApp);
