cmake_minimum_required(VERSION 3.22.1)

project(feelmyrythm_native_audio LANGUAGES CXX)

find_package(oboe REQUIRED CONFIG)

add_library(native-audio SHARED native-audio.cpp)
target_compile_features(native-audio PRIVATE cxx_std_17)
target_compile_options(native-audio PRIVATE -Wall -Wextra -Werror)
target_link_libraries(native-audio PRIVATE oboe::oboe android log)
