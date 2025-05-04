return {
  "folke/flash.nvim",
  event = { "BufReadPost", "BufNewFile" },
  opts = {
    jump = {
      nohlsearch = true,
    },
    highlight = {
      backdrop = false,
      groups = {
        label = "FlashLabel",
      },
    },
    modes = {
      search = {
        enabled = true,
      },
      char = {
        enabled = true,
        highlight = {
          backdrop = false,
        },
      },
    },
  },
  -- stylua: ignore
  keys = {
    { "r", mode = "o", function() require("flash").remote() end, desc = "Remote Flash" },
    { "S", mode = { "n", "x", "o" }, function() require("flash").treesitter() end, desc = "Flash Treesitter" },
    { "R", mode = { "o", "x" }, function() require("flash").treesitter_search() end, desc = "Treesitter Search" },
  },
}
