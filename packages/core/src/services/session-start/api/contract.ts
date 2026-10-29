import { defineContract, fallible } from '@emdash/wire/rpc';
import { z } from 'zod';
import {
  acpSessionStartInputSchema,
  acpSessionStartResultSchema,
  sessionStartErrorSchema,
  sessionStopInputSchema,
  tuiSessionStartInputSchema,
  tuiSessionStartResultSchema,
} from './schemas';

export const acpSessionStartContract = defineContract({
  startSession: fallible({
    input: acpSessionStartInputSchema,
    data: acpSessionStartResultSchema,
    error: sessionStartErrorSchema,
  }),
  terminate: fallible({
    input: sessionStopInputSchema,
    error: sessionStartErrorSchema,
  }),
});

export const tuiSessionStartContract = defineContract({
  startSession: fallible({
    input: tuiSessionStartInputSchema,
    data: tuiSessionStartResultSchema,
    error: sessionStartErrorSchema,
  }),
  kill: fallible({
    input: sessionStopInputSchema,
    data: z.void(),
    error: sessionStartErrorSchema,
  }),
});

export type AcpSessionStartContract = typeof acpSessionStartContract;
export type TuiSessionStartContract = typeof tuiSessionStartContract;
