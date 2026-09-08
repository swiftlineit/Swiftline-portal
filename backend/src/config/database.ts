import mongoose from "mongoose";

import { env } from "./env.js";

export async function connectDatabase(): Promise<void> {
  try {
    // Development and isolated tests may build schema indexes automatically.
    // Production uses reviewed, explicit migrations so a restart never spends
    // request-serving time creating or rebuilding indexes.
    const manageIndexesAutomatically = env.NODE_ENV !== "production";
    mongoose.set("autoIndex", manageIndexesAutomatically);
    mongoose.set("autoCreate", manageIndexesAutomatically);
    mongoose.set("strictQuery", false);

    await mongoose.connect(env.MONGODB_URI, {
      family: 4
    });

    console.log("MongoDB connected successfully");
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    throw error;
  }
}
