import { boltApp } from "./bolt";
import { registerMessageHandler } from "./handlers/message";
import { registerReactionHandler } from "./handlers/reaction";
import { registerCommandHandlers } from "./handlers/commands";
import { registerUserSyncHandlers } from "./handlers/userSync";

registerMessageHandler(boltApp);
registerReactionHandler(boltApp);
registerCommandHandlers(boltApp);
registerUserSyncHandlers(boltApp);
