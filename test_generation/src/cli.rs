use crate::{commands::generate_type_output, types::Type};
use std::{collections::HashMap, path::PathBuf};

use anyhow::Context;
use clap::Parser;

#[derive(Parser)]
#[command(version, about, long_about = None)]
pub struct Cli {
    /// Path of the file to generate tests to
    pub path: PathBuf,
}

impl Cli {
    pub fn generate_types(&self) -> anyhow::Result<HashMap<String, Type>> {
        let mut types: HashMap<String, Type> = HashMap::new();
        let contents = generate_type_output(&self.path).context("generating type string output")?;
        let contents: Vec<String> = contents
            .lines()
            .skip_while(|line| !line.contains("FINAL:"))
            .skip(1)
            .map(|line| line.trim().to_string())
            .take_while(|line| !line.is_empty())
            .collect();
        for line in contents {
            let (v_name, v_type) = line.split_once(':').unwrap();
            let v_name = v_name.trim();
            let v_type = v_type.trim();
            let parsed_type = Type::parse(v_type);
            types.insert(v_name.to_string(), parsed_type);
        }
        Ok(types)
    }
}
