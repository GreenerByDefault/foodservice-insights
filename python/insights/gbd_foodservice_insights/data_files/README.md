# Data files

`fonts/` is committed: the Poppins Regular/Bold OFL files the report renders with, plus
Lato Regular/Bold for the ₂ in "CO₂e", which Poppins lacks. `plotting_utils.setup_gbd_fonts()`
registers them via `font_manager.addfont` rather than relying on the OS or worker image.
