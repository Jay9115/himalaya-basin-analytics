import ast
from dataclasses import dataclass, field
from typing import Dict, List, Set


MAX_AST_NODES = 4000
MAX_CODE_CHARS = 20000

ALLOWED_IMPORT_ROOTS: Set[str] = {
    "math",
    "statistics",
    "numpy",
    "pandas",
}

BLOCKED_NAMES: Set[str] = {
    "__import__",
    "breakpoint",
    "builtins",
    "classmethod",
    "compile",
    "ctypes",
    "delattr",
    "dir",
    "eval",
    "exec",
    "exit",
    "getattr",
    "globals",
    "help",
    "input",
    "inspect",
    "locals",
    "memoryview",
    "object",
    "open",
    "property",
    "quit",
    "setattr",
    "staticmethod",
    "super",
    "type",
    "vars",
}

BLOCKED_MODULE_ROOTS: Set[str] = {
    "asyncio",
    "base64",
    "codecs",
    "concurrent",
    "email",
    "ftplib",
    "glob",
    "hashlib",
    "http",
    "importlib",
    "io",
    "marshal",
    "multiprocessing",
    "os",
    "pathlib",
    "pickle",
    "pkgutil",
    "platform",
    "psutil",
    "requests",
    "resource",
    "runpy",
    "secrets",
    "shutil",
    "signal",
    "socket",
    "sqlite3",
    "ssl",
    "subprocess",
    "sys",
    "tempfile",
    "threading",
    "urllib",
    "webbrowser",
}

BLOCKED_ATTRS: Set[str] = {
    "connect",
    "dump",
    "dumps",
    "fromfile",
    "genfromtxt",
    "load",
    "loads",
    "loadtxt",
    "memmap",
    "open",
    "plot",
    "read_clipboard",
    "read_csv",
    "read_excel",
    "read_feather",
    "read_fwf",
    "read_gbq",
    "read_hdf",
    "read_html",
    "read_json",
    "read_orc",
    "read_parquet",
    "read_pickle",
    "read_sas",
    "read_spss",
    "read_sql",
    "read_sql_query",
    "read_sql_table",
    "read_stata",
    "read_table",
    "request",
    "save",
    "savetxt",
    "savez",
    "savez_compressed",
    "send",
    "socket",
    "to_clipboard",
    "to_csv",
    "to_excel",
    "to_feather",
    "to_gbq",
    "to_hdf",
    "to_html",
    "to_json",
    "to_latex",
    "to_markdown",
    "to_orc",
    "to_parquet",
    "to_pickle",
    "to_sql",
    "to_stata",
    "to_xml",
    "urlopen",
}

BLOCKED_NODE_TYPES = (
    ast.AsyncFor,
    ast.AsyncFunctionDef,
    ast.AsyncWith,
    ast.Await,
    ast.Delete,
    ast.Global,
    ast.Nonlocal,
    ast.Yield,
    ast.YieldFrom,
)


@dataclass
class SecurityValidationResult:
    ok: bool
    errors: List[Dict[str, object]] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


class OperationSecurityVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.errors: List[Dict[str, object]] = []
        self.node_count = 0

    def generic_visit(self, node: ast.AST) -> None:
        self.node_count += 1
        if self.node_count > MAX_AST_NODES:
            self._error(node, f"Code is too complex. Limit is {MAX_AST_NODES} AST nodes.")
            return
        if isinstance(node, BLOCKED_NODE_TYPES):
            self._error(node, f"{type(node).__name__} is not allowed in custom operations.")
        super().generic_visit(node)

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            root = alias.name.split(".", 1)[0]
            if root in BLOCKED_MODULE_ROOTS or root not in ALLOWED_IMPORT_ROOTS:
                self._error(node, f"Import '{alias.name}' is not allowed.")
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.level and node.level > 0:
            self._error(node, "Relative imports are not allowed.")
            return

        module = node.module or ""
        root = module.split(".", 1)[0]
        if root in BLOCKED_MODULE_ROOTS or root not in ALLOWED_IMPORT_ROOTS:
            self._error(node, f"Import from '{module}' is not allowed.")

        for alias in node.names:
            if alias.name == "*" or alias.name in BLOCKED_NAMES or alias.name in BLOCKED_ATTRS:
                self._error(node, f"Import member '{alias.name}' is not allowed.")
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if node.id.startswith("__") or node.id in BLOCKED_NAMES or node.id in BLOCKED_MODULE_ROOTS:
            self._error(node, f"Name '{node.id}' is not allowed.")
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr.startswith("__") or node.attr in BLOCKED_ATTRS:
            self._error(node, f"Attribute '{node.attr}' is not allowed.")
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        call_name = self._call_name(node.func)
        if call_name:
            root = call_name.split(".", 1)[0]
            tail = call_name.rsplit(".", 1)[-1]
            if root in BLOCKED_NAMES or root in BLOCKED_MODULE_ROOTS:
                self._error(node, f"Call '{call_name}' is not allowed.")
            if tail in BLOCKED_NAMES or tail in BLOCKED_ATTRS:
                self._error(node, f"Call '{call_name}' is not allowed.")
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        if node.name.startswith("__"):
            self._error(node, f"Function name '{node.name}' is not allowed.")
        if node.decorator_list:
            self._error(node, "Decorators are not allowed in custom operations.")
        self.generic_visit(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        if node.name.startswith("__"):
            self._error(node, f"Class name '{node.name}' is not allowed.")
        if node.decorator_list:
            self._error(node, "Decorators are not allowed in custom operations.")
        self.generic_visit(node)

    def _call_name(self, func: ast.AST) -> str:
        if isinstance(func, ast.Name):
            return func.id
        if isinstance(func, ast.Attribute):
            parent = self._call_name(func.value)
            return f"{parent}.{func.attr}" if parent else func.attr
        return ""

    def _error(self, node: ast.AST, message: str) -> None:
        self.errors.append(
            {
                "line": getattr(node, "lineno", None),
                "column": getattr(node, "col_offset", None),
                "message": message,
            }
        )


def validate_python_code(code: str) -> SecurityValidationResult:
    if len(code) > MAX_CODE_CHARS:
        return SecurityValidationResult(
            ok=False,
            errors=[
                {
                    "line": None,
                    "column": None,
                    "message": f"Code is too large. Limit is {MAX_CODE_CHARS} characters.",
                }
            ],
        )

    if "\x00" in code:
        return SecurityValidationResult(
            ok=False,
            errors=[{"line": None, "column": None, "message": "Null bytes are not allowed."}],
        )

    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as exc:
        return SecurityValidationResult(
            ok=False,
            errors=[{"line": exc.lineno, "column": exc.offset, "message": exc.msg}],
        )

    visitor = OperationSecurityVisitor()
    visitor.visit(tree)
    warnings = [
        "This validator is a defense-in-depth check. Production deployments should use a container or microVM runner.",
    ]
    return SecurityValidationResult(ok=not visitor.errors, errors=visitor.errors, warnings=warnings)
