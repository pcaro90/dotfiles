return {
  "saghen/blink.cmp",
  event = "InsertEnter",
  version = "*",

  dependencies = { "fang2hou/blink-copilot" },

  ---@module 'blink.cmp'
  ---@type blink.cmp.Config
  opts = {
    keymap = { preset = "super-tab" },
    appearance = {
      nerd_font_variant = "normal",
    },
    completion = { documentation = { auto_show = true } },

    sources = {
      per_filetype = {
        codecompanion = { "codecompanion" },
      },
      default = { "lsp", "path", "snippets", "buffer", "copilot" },
      providers = {
        copilot = {
          name = "copilot",
          module = "blink-copilot",
          score_offset = 100,
          async = true,
        },
      },
    },

    fuzzy = { implementation = "prefer_rust_with_warning" },
  },

  keys = {
    {
      "<C-CR>",
      mode = { "i", "s" },
      function()
        require("blink.cmp").show()
      end,
      expr = true,
      desc = "Blink: Show Completion",
    },
  },

  -- config = function(_, opts)
  -- 	require("blink.cmp").setup(opts)
  -- 	vim.lsp.config("*", { capabilities = require("blink.cmp").get_lsp_capabilities(nil, true) })
  -- end,
  --
}
