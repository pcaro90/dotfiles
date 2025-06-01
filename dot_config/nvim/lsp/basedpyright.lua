-- Install: pipx install basedpyright

return {
  cmd = { "basedpyright-langserver", "--stdio" },
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
  settings = {
    basedpyright = {
      analysis = {
        autoSearchPaths = true,
        useLibraryCodeForTypes = true,
        diagnosticMode = "workspace",
        typeCheckingMode = "standard",
      },
    },
  },
}
