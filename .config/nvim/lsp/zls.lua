return {
  cmd = { "zls" },
  filetypes = { "zig", "zir" },
  root_markers = { "zls.json", "build.zig", ".git" },
  workspace_required = false,
  settings = {
    enable_build_on_save = true,
  },
}
