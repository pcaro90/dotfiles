return {
  "saghen/blink.cmp",
  event = "InsertEnter",
  version = "*",

  dependencies = { "fang2hou/blink-copilot" },

  ---@module 'blink.cmp'
  ---@type blink.cmp.Config
  opts = {
    keymap = {
      preset = "none",

      ["<C-Space>"] = { "show", "cancel", "fallback" },

      ["<Up>"] = { "select_prev" },
      ["<Down>"] = { "select_next" },

      ["<C-CR>"] = { "accept", "fallback" },
    },
    appearance = {
      nerd_font_variant = "normal",
    },
    completion = {
      documentation = { auto_show = true },
      ghost_text = {
        enabled = true,
        show_with_menu = true,
      },
      list = {
        selection = {
          preselect = true,
          auto_insert = false,
        },
      },
    },

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

  keys = {},

  -- config = function(_, opts)
  -- 	require("blink.cmp").setup(opts)
  -- 	vim.lsp.config("*", { capabilities = require("blink.cmp").get_lsp_capabilities(nil, true) })
  -- end,
  --
}
