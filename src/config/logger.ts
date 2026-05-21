import pino from "pino";
import { settings } from "./settings.js";

export const logger = pino({
  level: settings.logLevel,
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true } },
});
