-- Install: yay -S prettier stylua shfmt taplo-cli
-- Install: nimble install nph
-- Install: pipx install ruff
-- Install: rustup component add rustfmt

return {
  {
    "stevearc/conform.nvim",
    event = "VeryLazy",
    opts = {
      notify_on_error = true,
      format_on_save = false,
      formatters_by_ft = {
        c = { lsp_format = "prefer" },
        json = { "prettier", stop_on_first = true, timeout_ms = 500 },
        jsonc = { "prettier", stop_on_first = true, timeout_ms = 500 },
        lua = { "stylua" },
        markdown = { "prettier" },
        nim = { "nph" },
        python = { "ruff_format", timeout_ms = 500 },
        rust = { "rustfmt", timeout_ms = 500, lsp_format = "prefer" },
        sh = { "shfmt" },
        toml = { "taplo" },
        yaml = { "prettier" },

        -- For filetypes without a formatter:
        ["_"] = { "trim_whitespace", "trim_newlines" },
      },
      formatters = {
        stylua = {
          args = {
            "--indent-type",
            "Spaces",
            "--indent-width",
            "2",
            "--search-parent-directories",
            "--respect-ignores",
            "--stdin-filepath",
            "$FILENAME",
            "-",
          },
        },
      },
    },
    init = function()
      vim.o.formatexpr = "v:lua.require'conform'.formatexpr()"
    end,
    keys = {
      {
        "<leader>f",
        function()
          require("conform").format()
        end,
        desc = "Conform: Format file",
      },
    },
  },
}
