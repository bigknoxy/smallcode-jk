export { applyBatch, applyBlock, generateDiff } from "./applier.ts";
export { parse } from "./parser.ts";
export { repairBlock } from "./repair.ts";
export { applyPatchBlock, chooseEditFormat, parsePatchBlocks, PATCH_BYTE_THRESHOLD, PATCH_LINE_THRESHOLD } from "./patch-function.ts";
export type {
  ApplyBatchResult,
  ApplyResult,
  ApplyStatus,
  EditBlock,
  EditFormat,
  ParseError,
  ParseResult,
  RepairResult,
} from "./types.ts";
export type { PatchBlock, PatchParseError, PatchParseResult } from "./patch-function.ts";
