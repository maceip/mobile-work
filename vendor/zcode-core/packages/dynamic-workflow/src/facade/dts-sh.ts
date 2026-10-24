/**
 * zfacade E7: training-bridge workspace intrinsics (`sh.*`), full facade only.
 * Host utilities executed by the driver as admitted effects; `z_verify` runs a
 * host-registered immutable gate by ID (never an arbitrary command).
 */
export const FACADE_SH_SEGMENT = String.raw`
/** An immutable symbol anchor: file, exported symbol name, and content digest. */
declare interface SymbolRef {
  readonly file: string;
  readonly symbol: string;
  readonly digest: string;
  readonly signature?: string;
}

/** Bounded workspace inspection and registered verification gates. */
declare const sh: {
  /** Immutable symbol anchors and declarations for one file (no function bodies). */
  z_sig(target: string): Promise<SymbolRef[]>;
  /** Bounded 1-based source window with explicit line numbers. */
  z_slice(file: string, start: number, end: number): Promise<string>;
  /** Textual caller/reference candidates for a symbol under a directory. */
  z_impact(symbol: string, dir: string): Promise<SymbolRef[]>;
  /** Run a host-registered immutable gate by ID; returns its exit code and receipt ID. */
  z_verify(gateId: string): Promise<{ exit_code: number; receiptId: string }>;
};
`;
