return {
  settings = {
    Lua = {
      completion = { callSnippet = "Replace" },
      format = { enable = false }, -- Using stylua
      hint = {
        enable = true,
        arrayIndex = "Disable",
      },
      runtime = {
        version = "LuaJIT",
      },
      workspace = {
        checkThirdParty = false,
        library = {
          vim.env.VIMRUNTIME,
        },
      },
    },
  },
}
