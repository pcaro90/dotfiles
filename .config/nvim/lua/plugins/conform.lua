-- Install: yay -S prettier stylua shfmt taplo-cli
-- Install: nimble install nph
-- Install: pipx install ruff djlint
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
        fish = { "fish_indent" },
        jinja = { "djlint" },
        htmldjango = { "djlint" },
        json = { "prettier", stop_on_first = true, timeout_ms = 500 },
        jsonc = { "prettier", stop_on_first = true, timeout_ms = 500 },
        lua = { "stylua" },
        markdown = { "prettier" },
        nim = { "nph" },
        python = { "ruff_format", "ruff_organize_imports", timeout_ms = 500 },
        rust = { "rustfmt", timeout_ms = 500, lsp_format = "prefer" },
        sh = { "shfmt" },
        toml = { "taplo" },
        yaml = { "prettier" },
        zig = { "zigfmt" },
        zsh = { "shfmt" },

        -- For filetypes without a formatter:
        ["_"] = { "trim_whitespace", "trim_newlines" },
      },
      formatters = {
        stylua = {
          prepend_args = {
            "--indent-type",
            "Spaces",
            "--indent-width",
            "2",
          },
        },
        prettier = {
          prepend_args = function(_, ctx)
            if ctx.filename:match("[^/]+$") == "SKILL.md" then
              return { "--prose-wrap", "never" }
            end
            return { "--prose-wrap", "always" }
          end,
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
