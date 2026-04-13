return {
  "folke/tokyonight.nvim",
  opts = {
    on_highlights = function(hl, c)
      hl.FlashLabel = {
        bg = c.magenta2,
        bold = true,
        fg = c.black, -- Better visibility than default c.fg
      }
    end,
  },
  config = function()
    vim.cmd([[ colorscheme tokyonight-moon ]])
  end,
}
