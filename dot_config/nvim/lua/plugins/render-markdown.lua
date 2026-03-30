return {
  "MeanderingProgrammer/render-markdown.nvim",
  event = {"BufReadPost", "BufNewFile"},
  dependencies = { "nvim-treesitter/nvim-treesitter", "nvim-tree/nvim-web-devicons" },
  opts = {
    completions = { lsp = { enabled = true } },
  },
}
