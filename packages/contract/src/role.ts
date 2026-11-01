import { type Static, Type } from '@sinclair/typebox';

export const Role = Type.Union([Type.Literal('user'), Type.Literal('admin')]);
export type Role = Static<typeof Role>;
