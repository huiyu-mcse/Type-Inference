#![allow(dead_code, unused)]

/// A function parameter — either a plain value or a nested callback function.
/// This is needed to preserve the recursive nature of `Type::generate`, as there would be no way to
/// do so without this type
#[derive(Debug, Clone)]
pub enum Param {
    /// Any non-function value: num, str, Object, etc.
    Value(Type),
    /// A function passed as an argument, with its own params and return type.
    Callback(Vec<Param>, Box<Param>),
}

impl Param {
    fn parse(s: &str) -> Self {
        if s.starts_with("Func<") {
            let open = s.find('{').expect("Callback type always has {");
            let close = s.rfind('}').expect("Callback type always has }");
            let inner = &s[open + 1..close];
            let pieces = split_arrows(inner);
            let (ret_str, param_strs) = pieces.split_last().unwrap_or((&"void", &[]));
            let params = if param_strs == ["()"] {
                vec![]
            } else {
                param_strs.iter().map(|s| Param::parse(s)).collect()
            };
            Param::Callback(params, Box::new(Param::parse(ret_str)))
        } else {
            Param::Value(Type::parse(s))
        }
    }

    /// Generates a value expression for this param — suitable for use in a `return` or assignment.
    /// For a `Value`, delegates to `Type::generate`. For a `Callback`, produces a function literal.
    fn generate_as_expr(&self) -> String {
        match self {
            Param::Value(t) => match t {
                Type::Void => String::new(),
                _ => t.generate("anon".to_string()),
            },
            Param::Callback(params, ret) => {
                let param_names: Vec<String> = (0..params.len()).map(|i| format!("p{i}")).collect();
                let ret_expr = ret.generate_as_expr();
                if ret_expr.is_empty() {
                    format!("function({}) {{}}", param_names.join(", "))
                } else {
                    format!(
                        "function({}) {{ return {}; }}",
                        param_names.join(", "),
                        ret_expr
                    )
                }
            }
        }
    }

    fn generate(&self, param_name: &str) -> String {
        let mut result = String::new();
        match self {
            Param::Value(value_type) => {
                result.push_str(&format!(
                    "const {param_name} = {};\n",
                    value_type.generate("anon".to_string())
                ));
                result
            }
            Param::Callback(cb_params, cb_ret_type) => {
                let mut cb_param_names: Vec<String> = Vec::with_capacity(cb_params.len());
                for (cb_param_i, cb_param_type) in cb_params.iter().enumerate() {
                    let cb_param_name = format!("{param_name}__cb__param__{cb_param_i}");
                    cb_param_names.push(cb_param_name);
                    result.push_str(&cb_param_type.generate("anon"));
                }
                let ret_expr = cb_ret_type.generate_as_expr();
                if ret_expr.is_empty() {
                    result.push_str(&format!(
                        "const {param_name} = function({}) {{}};\n",
                        cb_param_names.join(", "),
                    ));
                } else {
                    result.push_str(&format!(
                        "const {param_name} = function({}) {{\nreturn {};\n}};\n",
                        cb_param_names.join(", "),
                        ret_expr,
                    ));
                }
                result
            }
        }
    }
}

/// An enum representation of the types generated from the solver
#[derive(Debug, Clone)]
pub enum Type {
    /// A simple number
    Num,
    /// A string
    Str,
    /// A boolean
    Bool,
    /// Any type
    Bot,
    /// No return type. Only exists on function return types
    Void,
    /// No parameter. On exists on function parameters
    Empty,
    /// The error type
    Error,
    /// A Regular Expression in JS
    Regexp,
    /// A variable that can safely have two types such as `num|str`
    Union(Box<Type>, Box<Type>),
    /// An anonymous Object that groups fields and types like such:
    /// `{field_1: T_1, field_2: T_2 ... field_n: T_n}`.
    /// `String` is the field's name, `Type` is its Type.
    Object(Vec<(String, Type)>),
    /// An Array over a generic type
    Array(Box<Type>),
    /// A function with parameter types `T_1, T_2 ... T_n` and a single return type
    Func(Vec<Param>, Box<Type>),
    /// A Class with `String` name and a Vector of methods/attributes
    Class(String, Vec<(String, Type)>),
    /// A known Class instance  with `String` name and a Vector of methods/attributes.
    /// These must correspond to the Class with the respective name
    Obj(String, Vec<(String, Type)>),
}

impl Type {
    pub fn parse(s: &str) -> Self {
        match s {
            "num" => Self::Num,
            "str" => Self::Str,
            "bool" => Self::Bool,
            "bot" => Self::Bot,
            "void" => Self::Void,
            "error" => Self::Error,
            "regexp" => Self::Regexp,
            // TODO: Union case
            t if t.contains('|') => Self::Bot,
            // Object case
            t if t.starts_with('{') => {
                let inner = &t[1..t.len() - 1];
                // Empty object
                if inner.is_empty() {
                    Self::Object(vec![])
                } else {
                    let attr_type_pair: Vec<(String, Type)> = split_commas(inner)
                        .into_iter()
                        .map(|attr_type| {
                            let (attr_name, attr_type) = attr_type.split_once(": ").unwrap();
                            (attr_name.to_string(), Type::parse(attr_type))
                        })
                        .collect();
                    Self::Object(attr_type_pair)
                }
            }
            t if t.starts_with("Array<") => {
                let open = t.find('<').expect("Array type always begins with <");
                let close = t.rfind('>').expect("Array type always ends with >");
                let inner_type = &t[open + 1..close];
                Self::Array(Box::new(Type::parse(inner_type)))
            }
            // Function case
            t if t.starts_with("Func<") => {
                let open = t.find('{').expect("Function type always begins with {");
                let close = t.rfind('}').expect("Function type always ends with }");
                let inner = &t[open + 1..close];
                let pieces = split_arrows(inner);
                let (ret_str, param_strs) = pieces.split_last().unwrap_or((&"void", &[]));
                let ret = Type::parse(ret_str);
                let params = if param_strs == ["()"] {
                    vec![]
                } else {
                    param_strs.iter().map(|s| Param::parse(s)).collect()
                };
                Self::Func(params, Box::new(ret))
            }
            // TODO: Class case
            t if t.starts_with("Class<") => Self::Bot,
            // TODO: Class instance case
            t if t.starts_with("Obj<") => Self::Bot,
            // This case can only happen inside of function parameters and it means that the
            // function doesn't have any
            "()" => Self::Empty,
            _ => Self::Bot,
        }
    }
    pub fn generate(&self, name: String) -> String {
        let mut result = String::new();
        match self {
            Type::Num => {
                // format!("var {name} = sym.number();")
                "sym.number()".to_string()
            }
            Type::Str => {
                // format!("var {name} = sym.string();")
                "sym.string()".to_string()
            }
            Type::Bool => {
                // format!("var {name} = sym.bool();")
                "sym.bool()".to_string()
            }
            Type::Bot => "bot".to_string(),
            Type::Void => todo!(),
            Type::Empty => "".to_string(),
            Type::Error => todo!(),
            Type::Regexp => todo!(),
            Type::Union(_, _) => todo!(),
            Type::Object(items) => {
                result.push('{');
                result.push_str(
                    &items
                        .iter()
                        .map(|(prop_name, prop_type)| {
                            format!("{prop_name}: {}", prop_type.generate("anon".to_string()))
                        })
                        .collect::<Vec<String>>()
                        .join(", "),
                );
                result.push('}');
                result
            }
            Type::Array(inner_type) => {
                result.push_str(&format!("[{}]", inner_type.generate("anon".to_string())));
                result
            }
            // NOTE: It is possible that we can ignore the return value in this case
            Type::Func(params, _) => {
                let mut param_names: Vec<String> = Vec::with_capacity(params.len());
                for (param_i, param_type) in params.iter().enumerate() {
                    let param_name = format!("{name}__param_{param_i}");
                    param_names.push(param_name.clone());
                    result.push_str(&param_type.generate(&param_name));
                }
                result.push_str(&format!("m.{name}({});\n", param_names.join(", ")));
                result
            }
            // TODO: Class case
            Type::Class(_, items) => todo!(),
            // TODO: Class instance case
            Type::Obj(_, items) => todo!(),
        }
    }
}

/// Splits `s` on `delim` but only at brace depth 0, so nested `{...}` blocks are never split inside.
fn split_on<'a>(s: &'a str, delim: &str) -> Vec<&'a str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    let mut i = 0;
    while i < s.len() {
        match s.as_bytes()[i] {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ if depth == 0 && s.get(i..).is_some_and(|sub| sub.starts_with(delim)) => {
                parts.push(s[start..i].trim());
                i += delim.len();
                start = i;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    parts.push(s[start..].trim());
    parts
}

fn split_arrows(s: &str) -> Vec<&str> {
    split_on(s, " -> ")
}
fn split_commas(s: &str) -> Vec<&str> {
    split_on(s, ", ")
}
