import { Schema, model, models } from "mongoose";

const UserSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    fullName: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: { type: String },
    passwordHash: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: ["super_admin", "admin", "manager", "employee"],
      default: "employee",
      index: true,
    },
    employeeCode: { type: String, trim: true },
    department: { type: String },
    designation: { type: String },
    managerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    joiningDate: { type: Date },
    isActive: { type: Boolean, default: true, index: true },
    resetTokenHash: { type: String, select: false },
    resetTokenExpires: { type: Date, select: false },
  },
  { timestamps: true }
);

// Employee codes are unique per company — but only among users that HAVE one.
//
// This was `sparse: true`, which does not do that on a COMPOUND index: a sparse
// compound index skips a document only when it is missing EVERY indexed field.
// companyId is required on every user, so every user was indexed, with
// employeeCode null. The second user without a code in the same company then
// collided on { companyId, null } and the create failed — surfacing as a
// confusing "Already exists" 409, since withApi maps duplicate-key to 409.
// Admins, managers and any employee left without a code are all affected.
//
// A partial index expresses the real rule: only index rows that actually carry
// a code, so any number of users may have none.
UserSchema.index(
  { companyId: 1, employeeCode: 1 },
  { unique: true, partialFilterExpression: { employeeCode: { $type: "string" } } }
);

export const User = (models.User as any) || model("User", UserSchema);
