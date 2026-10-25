import { Schema } from "effect";

export class AccountUnavailable extends Schema.TaggedErrorClass<AccountUnavailable>()(
  "AccountUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}
