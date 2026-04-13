-- Install: pipx install ty

return {
  cmd = { "ty", "server" },
  filetypes = { "python" },
  root_markers = {
    ".git",
    ".venv",
    "Pipfile",
    "pyproject.toml",
    "pyrightconfig.json",
    "requirements.txt",
    "setup.cfg",
    "setup.py",
    "venv",
  },
  init_options = {
    logFile = "/tmp/ty.log",
    logLevel = "debug",
  },
  settings = {
    ty = {
      diagnosticMode = "workspace",
    },
  },
}
