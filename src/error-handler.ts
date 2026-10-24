import { type Request, type Response, type NextFunction } from "express";

export class ExpectedError extends Error {
  readonly statusCode;
  constructor(
    message: string,
    statusCode: number,
    options?: ErrorOptions | undefined,
  ) {
    super(message, options);
    this.statusCode = statusCode;
  }
}

// errors from express/body-parser (malformed JSON, body too large, ...) carry their own 4xx status
const isClientHttpError = (err: Error): err is Error & { status: number } => {
  const { status, expose } = err as { status?: unknown; expose?: unknown };
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    expose === true
  );
};

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (res.headersSent) {
    console.error(err);
    next(err);
  } else if (err instanceof ExpectedError) {
    if (err.statusCode >= 500) {
      console.error(err);
    } else {
      console.log("error:", err.message);
    }
    res.status(err.statusCode).json({ error: err.message });
  } else if (isClientHttpError(err)) {
    console.log("error:", err.message);
    res.status(err.status).json({ error: err.message });
  } else {
    console.error(err);
    res.status(500).json({ error: "internal server error" });
  }
};
