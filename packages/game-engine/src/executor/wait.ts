import { success, type ActionHandler } from "./types";

export const executeWait: ActionHandler<"WAIT"> = async () => success("Held position.");
