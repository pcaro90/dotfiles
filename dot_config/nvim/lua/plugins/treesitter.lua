return {
  "nvim-treesitter/nvim-treesitter",
  branch = "main",
  build = ":TSUpdate",
  event = { "BufReadPre", "BufNewFile" },
  main = "nvim-treesitter",
  init = function()
    -- Set up an autocommand to enable treesitter and indentation when a file is opened
    vim.api.nvim_create_autocmd("FileType", {
      callback = function()
        -- Enable treesitter highlighting and disable regex syntax
        pcall(vim.treesitter.start)
        -- Enable treesitter-based indentation
        vim.bo.indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
      end,
    })

    local ensureInstalled = {
      "bash",
      "c",
      "cpp",
      "diff",
      "gitcommit",
      "go",
      "html",
      "json",
      "json5",
      "lua",
      "luadoc",
      "markdown",
      "markdown_inline",
      "nim",
      "nim_format_string",
      "python",
      "regex",
      "rust",
      "toml",
      "vim",
      "vimdoc",
      "yaml",
      "zig",
    }
    local alreadyInstalled = require("nvim-treesitter.config").get_installed()
    local parsersToInstall = vim
      .iter(ensureInstalled)
      :filter(function(parser)
        return not vim.tbl_contains(alreadyInstalled, parser)
      end)
      :totable()
    require("nvim-treesitter").install(parsersToInstall)
  end,
  opts = {
    auto_install = true,
    highlight = {
      disable = { "csv" },
      additional_vim_regex_highlighting = { "ruby" },
    },
    indent = { disable = { "ruby" } },
  },
}
