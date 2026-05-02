import { boltApp } from "./bolt";
import { registerMessageHandler } from "./handlers/message";

registerMessageHandler(boltApp);
