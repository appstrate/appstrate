import pino from "pino";

const pinoLogger = pino({
  level: process.env.LOG_LEVEL || "info",
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
