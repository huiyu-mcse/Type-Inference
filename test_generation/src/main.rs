mod cli;
mod commands;
mod types;

use crate::types::Type;
use anyhow::Context;
use clap::Parser;
use cli::Cli;

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let types = cli.generate_types().context("running the main command")?;
    // Parse, don't validate. This is a singular point of failure while checking for the presence of
    // an exported value
    let exported_types = match types.get("exports__global") {
        Some(single_export) => match single_export {
            Type::Object(props) => props.clone(),
            _ => panic!("exports must be an object"),
        },
        // "exports__global" isn't in the package. The only other way we consider for exporting values is via `module.exports`
        None => {
            let module = types
                .get("module__global")
                .expect("The package under test should be exporting something");
            if let Type::Object(props) = module {
                match &props
                    .iter()
                    .next()
                    .expect("`module` must only have `exports` as a property")
                    .1
                {
                    Type::Object(export_props) => export_props.clone(),
                    _ => panic!("exports must be an object"),
                }
            } else {
                panic!("Module has no `exports` propery");
            }
        }
    };
    let mut result = String::new();
    // TODO: Change "module" for the actual module under test's name
    result.push_str("const m = require(\"module\");\n\n");
    for (prop_name, prop_type) in exported_types {
        match prop_type {
            Type::Func(_, _) => result.push_str(&format!(
                "// Generating test case for function `{prop_name}`\n"
            )),
            Type::Object(_) => result.push_str(&format!(
                "// Generating test case for Object `{prop_name}`\n"
            )),
            Type::Class(_, _) => {
                todo!("We still don't know how to generate test cases for Classes")
            }
            _ => panic!(
                "Do you really need to generate test cases for anything other that functions, classes and objects??"
            ),
        };
        result.push_str(&prop_type.generate(prop_name.to_string()));
        result.push('\n');
    }
    println!("{}", result.trim());
    Ok(())
}
