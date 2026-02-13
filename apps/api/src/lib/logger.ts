type LogLevel = "debug" | "info" | "warn" | "error";

function emit(level: LogLevel, msg: string, data?: Record<string, unknown>) {
  const entry = {
    level,
    msg,
    timestamp: new Date().toISOString(),
    ...data,
  };

  const line = JSON.stringify(entry);

  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "debug":
      console.debug(line);
      break;
    default:
      console.log(line);
  }
}

export const logger = {
  debug(msg: string, data?: Record<string, unknown>) {
    emit("debug", msg, data);
  },
  info(msg: string, data?: Record<string, unknown>) {
    emit("info", msg, data);
  },
  warn(msg: string, data?: Record<string, unknown>) {
    emit("warn", msg, data);
  },
  error(msg: string, data?: Record<string, unknown>) {
    emit("error", msg, data);
  },
};
