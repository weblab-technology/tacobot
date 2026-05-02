import { boltApp } from "./bolt";
import { registerMessageHandler } from "./handlers/message";
import { registerReactionHandler } from "./handlers/reaction";

registerMessageHandler(boltApp);
registerReactionHandler(boltApp);
