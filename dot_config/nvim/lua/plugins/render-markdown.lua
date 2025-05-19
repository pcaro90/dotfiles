return {
  "MeanderingProgrammer/render-markdown.nvim",
  event = {"BufReadPost", "BufNewFile"},
  dependencies = { "nvim-treesitter/nvim-treesitter", "nvim-tree/nvim-web-devicons" }, -- if you prefer nvim-web-devicons
  opts = {
    completions = { blink = { enabled = true } },
  },
}
