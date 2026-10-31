import { ExpectedError } from "./error-handler.js";
import {
  DIETARY_OPTIONS,
  ROLES,
  type Coordinates,
  type DietaryOption,
  type Role,
  type RsvpInput,
} from "./model.js";

const MAX_TEXT_LENGTH = 500;
const MAX_NAME_LENGTH = 100;

const badRequest = (message: string) => new ExpectedError(message, 400);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const parseCoordinates = (value: unknown, at: string): Coordinates | null => {
  if (value === null) {
    return null;
  }
  if (!isObject(value)) {
    throw badRequest(`${at} must be { lat, lng } or null`);
  }
  const { lat, lng } = value;
  if (
    typeof lat !== "number" ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90
  ) {
    throw badRequest(`${at}.lat must be a number between -90 and 90`);
  }
  if (
    typeof lng !== "number" ||
    !Number.isFinite(lng) ||
    lng < -180 ||
    lng > 180
  ) {
    throw badRequest(`${at}.lng must be a number between -180 and 180`);
  }
  return { lat, lng };
};

const parseRsvp = (value: unknown, index: number): RsvpInput => {
  const at = `rsvps[${index}]`;
  if (!isObject(value)) {
    throw badRequest(`${at} must be an object`);
  }
  const {
    guestId,
    attending,
    dietary,
    dietaryOtherDetails = null,
    shuttle = null,
  } = value;
  if (!isId(guestId)) {
    throw badRequest(`${at}.guestId must be a guest id`);
  }
  if (typeof attending !== "boolean") {
    throw badRequest(`${at}.attending must be true or false`);
  }
  if (!attending) {
    return {
      guestId,
      attending,
      dietary: null,
      dietaryOtherDetails: null,
      shuttle: null,
    };
  }
  if (!DIETARY_OPTIONS.includes(dietary as DietaryOption)) {
    throw badRequest(
      `${at}.dietary must be one of ${DIETARY_OPTIONS.join(", ")} when attending`,
    );
  }
  if (
    dietary === "other" &&
    (typeof dietaryOtherDetails !== "string" ||
      !dietaryOtherDetails.trim() ||
      dietaryOtherDetails.length > MAX_TEXT_LENGTH)
  ) {
    throw badRequest(
      `${at}.dietaryOtherDetails is required for dietary "other" (max ${MAX_TEXT_LENGTH} characters)`,
    );
  }
  if (shuttle !== null && typeof shuttle !== "boolean") {
    throw badRequest(`${at}.shuttle must be true, false or null`);
  }
  return {
    guestId,
    attending,
    dietary: dietary as DietaryOption,
    dietaryOtherDetails:
      dietary === "other" ? (dietaryOtherDetails as string).trim() : null,
    shuttle,
  };
};

// { accommodation: { lat, lng } } sets a place, { accommodation: null } clears it
export const parseAccommodation = (body: unknown): Coordinates | null => {
  if (!isObject(body) || !("accommodation" in body)) {
    throw badRequest("expected { accommodation: { lat, lng } or null }");
  }
  return parseCoordinates(body.accommodation, "accommodation");
};

export const parseGroupId = (value: string | undefined): number => {
  const groupId = Number(value);
  if (!isId(groupId)) {
    throw badRequest("group id must be a positive integer");
  }
  return groupId;
};

export const parseRsvpBatch = (body: unknown): RsvpInput[] => {
  if (
    !isObject(body) ||
    !Array.isArray(body.rsvps) ||
    body.rsvps.length === 0
  ) {
    throw badRequest("expected { rsvps: [...] } with at least one RSVP");
  }
  const rsvps = body.rsvps.map(parseRsvp);
  if (new Set(rsvps.map((rsvp) => rsvp.guestId)).size !== rsvps.length) {
    throw badRequest("each guest can only appear once per request");
  }
  return rsvps;
};

export const parseGuestId = (value: string | undefined): number => {
  const guestId = Number(value);
  if (!isId(guestId)) {
    throw badRequest("guest id must be a positive integer");
  }
  return guestId;
};

const parseName = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_NAME_LENGTH
  ) {
    throw badRequest(
      `${field} must be a non-empty string (max ${MAX_NAME_LENGTH} characters)`,
    );
  }
  return value.trim();
};

const parseRoles = (value: unknown): Role[] => {
  if (
    !Array.isArray(value) ||
    !value.every((role) => ROLES.includes(role as Role)) ||
    new Set(value).size !== value.length
  ) {
    throw badRequest(
      `roles must be a list of distinct roles from ${ROLES.join(", ")}`,
    );
  }
  return value as Role[];
};

export type NewGuestInput = {
  // null puts the guest in a new group of their own
  groupId: number | null;
  name: string;
  surname: string;
  roles: Role[];
};

export const parseNewGuest = (body: unknown): NewGuestInput => {
  if (!isObject(body)) {
    throw badRequest("expected a guest object");
  }
  const { groupId = null, roles = [] } = body;
  if (groupId !== null && !isId(groupId)) {
    throw badRequest("groupId must be a positive integer or null");
  }
  return {
    groupId,
    name: parseName(body.name, "name"),
    surname: parseName(body.surname, "surname"),
    roles: parseRoles(roles),
  };
};

// null fields are left unchanged
export type GuestUpdateInput = {
  groupId: number | null;
  name: string | null;
  surname: string | null;
  roles: Role[] | null;
  regenerateInvite: boolean;
  unlinkGoogleAccount: boolean;
};

export const parseGuestUpdate = (body: unknown): GuestUpdateInput => {
  if (!isObject(body)) {
    throw badRequest("expected a guest update object");
  }
  const {
    groupId,
    name,
    surname,
    roles,
    regenerateInvite = false,
    unlinkGoogleAccount = false,
  } = body;
  if (groupId !== undefined && !isId(groupId)) {
    throw badRequest("groupId must be a positive integer");
  }
  if (
    typeof regenerateInvite !== "boolean" ||
    typeof unlinkGoogleAccount !== "boolean"
  ) {
    throw badRequest(
      "regenerateInvite and unlinkGoogleAccount must be true or false",
    );
  }
  const update: GuestUpdateInput = {
    groupId: groupId ?? null,
    name: name === undefined ? null : parseName(name, "name"),
    surname: surname === undefined ? null : parseName(surname, "surname"),
    roles: roles === undefined ? null : parseRoles(roles),
    regenerateInvite,
    unlinkGoogleAccount,
  };
  if (
    update.groupId === null &&
    update.name === null &&
    update.surname === null &&
    update.roles === null &&
    !regenerateInvite &&
    !unlinkGoogleAccount
  ) {
    throw badRequest("nothing to update");
  }
  return update;
};
