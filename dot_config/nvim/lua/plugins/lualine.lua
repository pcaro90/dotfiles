return {
  "nvim-lualine/lualine.nvim",
  event = "VeryLazy",
  dependencies = { "nvim-tree/nvim-web-devicons" },
  opts = {
    sections = {
      lualine_y = { "branch" },
      lualine_z = { "progress", "location" },
    },
  },
}
