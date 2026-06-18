import pino from "pino";

/**
 * Structured logger para el proyecto.
 *
 * - En desarrollo: logs legibles con colores (pino-pretty via transport)
 * - En producción: JSON estructurat para Datadog/ELK/Grafana
 * - Level configurable via env LOG_LEVEL (default: debug en dev, info en prod)
 */
const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
  // pino-pretty solo en development — en staging/production es JSON puro
  ...(process.env.NODE_ENV === "development" && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
      },
    },
  }),
});

export default logger;
