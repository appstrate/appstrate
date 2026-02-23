import pino from "pino";
import { getEnv } from "@appstrate/env";

const pinoLogger = pino({
  level: getEnv().LOG_LEVEL,
});

type LogFn = (msg: string, data?: Record<string, unknown>) => void;

function wrap(level: "debug" | "info" | "warn" | "error"): LogFn {
  return (msg, data) => {
    if (data) pinoLogger[level](data, msg);
    else pinoLogger[level](msg);
  };
}

export const logger = {
  debug: wrap("debug"),
  info: wrap("info"),
  warn: wrap("warn"),
  error: wrap("error"),
};
