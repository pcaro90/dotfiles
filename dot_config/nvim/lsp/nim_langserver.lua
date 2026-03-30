-- Install: nimble install nimlangserver

return {
  cmd = { "nimlangserver" },
  filetypes = { "nim" },
  root_dir = function(bufnr, on_dir)
    local fname = vim.api.nvim_buf_get_name(bufnr)
    local dirname = vim.fs.dirname(vim.fs.find(function(name, path)
      return name == ".git" or name:match("%.nimble$")
    end, { path = fname, upward = true })[1])
    on_dir(dirname)
  end,
  settings = {
    nim = {
      notificationVerbosity = "none",
    },
  },
}
