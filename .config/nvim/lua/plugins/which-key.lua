return {
  "folke/which-key.nvim",
  event = "VeryLazy",
  priority = -1000,
  opts_extend = { "spec" },
  opts = {
    preset = "helix",
    defaults = {},
    spec = {
      {
        mode = { "n", "v" },
        -- { "<leader><tab>", group = "tabs" },
        -- { "<leader>d", group = "debug" },
        -- { "<leader>dp", group = "profiler" },
        -- { "<leader>q", group = "quit/session" },
        -- { "<leader>s", group = "search" },
        -- { "<leader>u", group = "ui", icon = { icon = "󰙵 ", color = "cyan" } },
        -- { "ys", group = "surround" },

        { "[", group = "prev" },
        { "]", group = "next" },
        { "g", group = "goto" },
        { "z", group = "fold" },
        { "<leader>c", group = "comments" },
        { "<leader>f", group = "fzf" },
        { "<leader>d", group = "diagnostics", icon = { icon = "󱖫 ", color = "green" } },
        { "<leader>g", group = "git" },
        {
          "<leader>b",
          group = "buffers",
          expand = function()
            return require("which-key.extras").expand.buf()
          end,
        },
      },
    },
  },
  keys = {
    {
      "<leader>?",
      function()
        require("which-key").show({ global = false })
      end,
      desc = "Buffer Keymaps (which-key)",
    },
    {
      "<c-w><space>",
      function()
        require("which-key").show({ keys = "<c-w>", loop = true })
      end,
      desc = "Window Hydra Mode (which-key)",
    },
  },
}
