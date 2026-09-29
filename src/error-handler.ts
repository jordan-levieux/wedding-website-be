import { type Request, type Response, type NextFunction } from "express";

export class ExpectedError extends Error {
    readonly statusCode;
    constructor(message: string, statusCode: number, options?: ErrorOptions | undefined){
        super(message, options);
        this.statusCode = statusCode;
    }
}

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
    console.log("error:", err.message);
  if (res.headersSent) {
    next(err);
  } else if(err instanceof ExpectedError) {
    res.status(err.statusCode).json({error: err.message});
  } else {
    res.status(500).json({error: "internal server error"});
  }
};
