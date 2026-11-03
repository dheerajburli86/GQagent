"use strict";
// Database handle given to the live market tools. The model never gets the raw
// client: the wrapper exposes SELECT on an allowlist of tables and calls to an
// allowlist of read functions. There is no insert, update, upsert or delete.

function readOnlyClient(sb, { tables = [], rpcs = [], label = "db" } = {}) {
  const T = new Set(tables), R = new Set(rpcs);
  return Object.freeze({
    from(table) {
      if (!T.has(table)) throw new Error(`${label}: table "${table}" is not on the read allowlist`);
      const qb = sb.from(table);
      return Object.freeze({ select: (...a) => qb.select(...a) });
    },
    rpc(name, args) {
      if (!R.has(name)) throw new Error(`${label}: rpc "${name}" is not on the allowlist`);
      return sb.rpc(name, args);
    },
  });
}

module.exports = { readOnlyClient };
