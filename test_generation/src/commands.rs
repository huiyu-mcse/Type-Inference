use anyhow::Context;
use std::path::Path;
use std::process::{Command, Stdio};

/// Generates the output from `solver.js` to the file `js_file` received as argument
pub fn generate_type_output(js_file: &Path) -> anyhow::Result<String> {
    let infer_path = "../type_inference/infer.js";
    let solver_path = "../type_inference/solver.js";

    let mut infer = Command::new("node")
        .args([infer_path, js_file.to_str().unwrap()])
        .stdout(Stdio::piped())
        .spawn()
        .context("spawning infer command")?;

    let solver = Command::new("node")
        .args([solver_path, "--quiet"])
        .stdin(infer.stdout.take().unwrap())
        .output()
        .context("spawning solver command")?;

    infer.wait()?;
    let output = String::from_utf8(solver.stdout).context("converting output to String")?;

    Ok(output)
}
