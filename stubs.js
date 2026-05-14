"use strict";

// Module stub registry.
// Each entry: (fresh, addCons) => TV representing the module's export.
//   fresh:   () => string   — creates a fresh type variable name
//   addCons: (a, b) => void — emits constraint  a <= b
//
// All TVs are created fresh per call so separate require() invocations
// for the same module remain fully independent.

const stubs = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Single-function export: (str) -> void
function singleStrFn(name) {
  return (fresh, addCons) => {
    const T_p = fresh();
    addCons(T_p, "str");
    const T_ret = fresh();
    addCons(T_ret, "void");
    const T_fn = fresh();
    addCons(T_fn, `Func<${name}>{${T_p} -> ${T_ret}}`);
    return T_fn;
  };
}

// Object export with one method: { method: (str) -> void }
function objMethodStr(method) {
  return (fresh, addCons) => {
    const T_p = fresh();
    addCons(T_p, "str");
    const T_ret = fresh();
    addCons(T_ret, "void");
    const T_fn = fresh();
    addCons(T_fn, `Func<${method}>{${T_p} -> ${T_ret}}`);
    const T_mod = fresh();
    addCons(T_mod, `{${method}: ${T_fn}}`);
    return T_mod;
  };
}

// ── Node.js built-ins ─────────────────────────────────────────────────────────

stubs["child_process"] = (fresh, addCons) => {
  // exec callback: (err: bool, stdout: str, stderr: str) -> void
  const T_cb_err = fresh();
  addCons(T_cb_err, "bool");
  const T_cb_stdout = fresh();
  addCons(T_cb_stdout, "str");
  const T_cb_stderr = fresh();
  addCons(T_cb_stderr, "str");
  const T_cb_ret = fresh();
  addCons(T_cb_ret, "void");
  const T_exec_cb = fresh();
  addCons(
    T_exec_cb,
    `Func<exec_cb>{${T_cb_err} -> ${T_cb_stdout} -> ${T_cb_stderr} -> ${T_cb_ret}}`,
  );

  // exec(cmd: str, options: {}, callback) -> void
  const T_exec_cmd = fresh();
  addCons(T_exec_cmd, "str");
  const T_exec_opts = fresh();
  addCons(T_exec_opts, "{}");
  const T_exec_ret = fresh();
  addCons(T_exec_ret, "void");
  const T_exec = fresh();
  addCons(
    T_exec,
    `Func<exec>{${T_exec_cmd} -> ${T_exec_opts} -> ${T_exec_cb} -> ${T_exec_ret}}`,
  );

  // execSync(cmd: str, options: {}) -> str
  const T_esync_cmd = fresh();
  addCons(T_esync_cmd, "str");
  const T_esync_opts = fresh();
  addCons(T_esync_opts, "{}");
  const T_esync_ret = fresh();
  addCons(T_esync_ret, "str");
  const T_execSync = fresh();
  addCons(
    T_execSync,
    `Func<execSync>{${T_esync_cmd} -> ${T_esync_opts} -> ${T_esync_ret}}`,
  );

  // spawn(cmd: str, args: Array<str>) -> {}
  const T_spawn_cmd = fresh();
  addCons(T_spawn_cmd, "str");
  const T_spawn_elem = fresh();
  addCons(T_spawn_elem, "str");
  const T_spawn_args = fresh();
  addCons(T_spawn_args, `Array<${T_spawn_elem}>`);
  const T_spawn_ret = fresh();
  addCons(T_spawn_ret, "{}");
  const T_spawn = fresh();
  addCons(
    T_spawn,
    `Func<spawn>{${T_spawn_cmd} -> ${T_spawn_args} -> ${T_spawn_ret}}`,
  );

  const T_mod = fresh();
  addCons(
    T_mod,
    `{exec: ${T_exec}, execSync: ${T_execSync}, spawn: ${T_spawn}}`,
  );
  return T_mod;
};

stubs["path"] = (fresh, addCons) => {
  // join(part: str) -> str  (variadic modelled as single param)
  const T_join_p = fresh();
  addCons(T_join_p, "str");
  const T_join_ret = fresh();
  addCons(T_join_ret, "str");
  const T_join = fresh();
  addCons(T_join, `Func<path_join>{${T_join_p} -> ${T_join_ret}}`);

  // resolve(part: str) -> str
  const T_res_p = fresh();
  addCons(T_res_p, "str");
  const T_res_ret = fresh();
  addCons(T_res_ret, "str");
  const T_resolve = fresh();
  addCons(T_resolve, `Func<path_resolve>{${T_res_p} -> ${T_res_ret}}`);

  const T_mod = fresh();
  addCons(T_mod, `{join: ${T_join}, resolve: ${T_resolve}}`);
  return T_mod;
};

stubs["fs"] = (fresh, addCons) => {
  // readFileSync(path: str, options: str) -> str
  const T_rfs_p = fresh();
  addCons(T_rfs_p, "str");
  const T_rfs_enc = fresh();
  addCons(T_rfs_enc, "str");
  const T_rfs_ret = fresh();
  addCons(T_rfs_ret, "str");
  const T_readFileSync = fresh();
  addCons(
    T_readFileSync,
    `Func<readFileSync>{${T_rfs_p} -> ${T_rfs_enc} -> ${T_rfs_ret}}`,
  );

  // writeFileSync(path: str, data: str) -> void
  const T_wfs_p = fresh();
  addCons(T_wfs_p, "str");
  const T_wfs_d = fresh();
  addCons(T_wfs_d, "str");
  const T_wfs_ret = fresh();
  addCons(T_wfs_ret, "void");
  const T_writeFileSync = fresh();
  addCons(
    T_writeFileSync,
    `Func<writeFileSync>{${T_wfs_p} -> ${T_wfs_d} -> ${T_wfs_ret}}`,
  );

  // readFile(path: str, encoding: str, callback: (err: bool, data: str) -> void) -> void
  const T_rf_cb_err = fresh();
  addCons(T_rf_cb_err, "bool");
  const T_rf_cb_dat = fresh();
  addCons(T_rf_cb_dat, "str");
  const T_rf_cb_ret = fresh();
  addCons(T_rf_cb_ret, "void");
  const T_rf_cb = fresh();
  addCons(
    T_rf_cb,
    `Func<readFile_cb>{${T_rf_cb_err} -> ${T_rf_cb_dat} -> ${T_rf_cb_ret}}`,
  );
  const T_rf_p = fresh();
  addCons(T_rf_p, "str");
  const T_rf_enc = fresh();
  addCons(T_rf_enc, "str");
  const T_rf_ret = fresh();
  addCons(T_rf_ret, "void");
  const T_readFile = fresh();
  addCons(
    T_readFile,
    `Func<readFile>{${T_rf_p} -> ${T_rf_enc} -> ${T_rf_cb} -> ${T_rf_ret}}`,
  );

  // writeFile(path: str, data: str, callback: () -> void) -> void
  const T_wf_cb_ret = fresh();
  addCons(T_wf_cb_ret, "void");
  const T_wf_cb = fresh();
  addCons(T_wf_cb, `Func<writeFile_cb>{() -> ${T_wf_cb_ret}}`);
  const T_wf_p = fresh();
  addCons(T_wf_p, "str");
  const T_wf_d = fresh();
  addCons(T_wf_d, "str");
  const T_wf_ret = fresh();
  addCons(T_wf_ret, "void");
  const T_writeFile = fresh();
  addCons(
    T_writeFile,
    `Func<writeFile>{${T_wf_p} -> ${T_wf_d} -> ${T_wf_cb} -> ${T_wf_ret}}`,
  );

  // stat(path: str, callback: (err: bool, stat: {}) -> void) -> void
  const T_st_cb_err = fresh();
  addCons(T_st_cb_err, "bool");
  const T_st_cb_stat = fresh();
  addCons(T_st_cb_stat, "{}");
  const T_st_cb_ret = fresh();
  addCons(T_st_cb_ret, "void");
  const T_st_cb = fresh();
  addCons(
    T_st_cb,
    `Func<stat_cb>{${T_st_cb_err} -> ${T_st_cb_stat} -> ${T_st_cb_ret}}`,
  );
  const T_st_p = fresh();
  addCons(T_st_p, "str");
  const T_st_ret = fresh();
  addCons(T_st_ret, "void");
  const T_stat = fresh();
  addCons(T_stat, `Func<stat>{${T_st_p} -> ${T_st_cb} -> ${T_st_ret}}`);

  // createWriteStream(path: str, options: {}) -> {}
  const T_cws_p = fresh();
  addCons(T_cws_p, "str");
  const T_cws_opt = fresh();
  addCons(T_cws_opt, "{}");
  const T_cws_ret = fresh();
  addCons(T_cws_ret, "{}");
  const T_createWriteStream = fresh();
  addCons(
    T_createWriteStream,
    `Func<createWriteStream>{${T_cws_p} -> ${T_cws_opt} -> ${T_cws_ret}}`,
  );

  const T_mod = fresh();
  addCons(
    T_mod,
    `{readFileSync: ${T_readFileSync}, writeFileSync: ${T_writeFileSync}, readFile: ${T_readFile}, writeFile: ${T_writeFile}, stat: ${T_stat}, createWriteStream: ${T_createWriteStream}}`,
  );
  return T_mod;
};

stubs["util"] = (fresh, addCons) => {
  // format(fmt: str, ...args) -> str  (modelled as two-param)
  const T_fmt_p1 = fresh();
  addCons(T_fmt_p1, "str");
  const T_fmt_p2 = fresh();
  const T_fmt_ret = fresh();
  addCons(T_fmt_ret, "str");
  const T_format = fresh();
  addCons(
    T_format,
    `Func<util_format>{${T_fmt_p1} -> ${T_fmt_p2} -> ${T_fmt_ret}}`,
  );

  const T_mod = fresh();
  addCons(T_mod, `{format: ${T_format}}`);
  return T_mod;
};

// ── Third-party package stubs (10 smallest PoCs) ─────────────────────────────

stubs["portkiller"] = singleStrFn("portkiller");
stubs["port-killer"] = singleStrFn("port-killer");
stubs["react-dev-utils/getProcessForPort"] = singleStrFn("getProcessForPort");
stubs["bestzip"] = singleStrFn("bestzip");

stubs["ps-kill"] = objMethodStr("kill");
stubs["psnode"] = objMethodStr("kill");
stubs["portprocesses"] = objMethodStr("killProcess");
stubs["npm-help"] = objMethodStr("latestVersion");
stubs["buns"] = objMethodStr("install");

// ts-process-promises: { exec: (cmd: str, opts: str) -> void }
stubs["ts-process-promises"] = (fresh, addCons) => {
  const T_p1 = fresh();
  addCons(T_p1, "str");
  const T_p2 = fresh();
  addCons(T_p2, "str");
  const T_ret = fresh();
  addCons(T_ret, "void");
  const T_fn = fresh();
  addCons(T_fn, `Func<ts_exec>{${T_p1} -> ${T_p2} -> ${T_ret}}`);
  const T_mod = fresh();
  addCons(T_mod, `{exec: ${T_fn}}`);
  return T_mod;
};

module.exports = stubs;
